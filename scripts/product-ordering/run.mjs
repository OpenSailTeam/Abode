#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { Shopify } from "./shopify.mjs";
import { STORE, API_VERSION } from "./operations.mjs";
import {
  ensure,
  checksum,
  makePlan,
  validatePlan,
  summary,
  reports,
  flagsFor,
  actionsFor,
  applyAction,
  guardState,
  same,
  expectedProducts,
  compareCatalog,
} from "./model.mjs";
export function options(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: "string", default: "dry-run" },
      out: { type: "string" },
      plan: { type: "string" },
      checksum: { type: "string" },
      "confirm-store": { type: "string" },
      "theme-ready": { type: "boolean", default: false },
      "dependencies-reviewed": { type: "boolean", default: false },
      "products-paused": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  ensure(
    ["dry-run", "plan", "apply", "verify", "rollback"].includes(values.mode),
    "Unknown mode",
  );
  const write = ["apply", "rollback"].includes(values.mode);
  if (write) {
    ensure(
      values.plan && /^[a-f0-9]{64}$/.test(values.checksum || ""),
      "A saved plan and its reviewed SHA-256 checksum are required",
    );
    ensure(
      values["confirm-store"] === STORE,
      "Explicit confirmation of the Abode store is required",
    );
    ensure(
      values["products-paused"],
      "Pause product editing before applying or rolling back",
    );
    if (values.mode === "apply")
      ensure(
        values["theme-ready"] && values["dependencies-reviewed"],
        "Confirm the live theme uses the new rules and contact-tag dependencies have been reviewed",
      );
  }
  if (values.mode === "verify")
    ensure(
      values.plan && values.checksum,
      "Verify requires the saved plan and checksum",
    );
  if (!["dry-run", "plan"].includes(values.mode))
    ensure(!values.out, "Use the saved plan directory for this mode");
  return { ...values, write };
}
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
function journalRows(file, hash) {
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  ensure(
    rows.every((r) => r.planHash === hash),
    "Journal belongs to a different plan",
  );
  return rows;
}
function append(file, row, hash) {
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(
      fd,
      JSON.stringify({
        ...row,
        planHash: hash,
        time: new Date().toISOString(),
      }) + "\n",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function inverse(prepared) {
  const a = prepared.action;
  return {
    key: `rollback:${a.key}`,
    productId: a.productId,
    kind: a.kind === "removeContact" ? "restoreContact" : "policies",
    ...(a.kind === "policies"
      ? {
          variants: a.variants.map((v) => ({
            id: v.id,
            inventoryPolicy: prepared.before.variants.find(
              (old) => old.id === v.id,
            ).inventoryPolicy,
          })),
        }
      : {}),
  };
}
const flagLabels = {
  "new-order-only-behavior":
    "Neither purchasing tag is present; the new theme makes this order-only",
  "instock-zero-stock-variant":
    "Tagged instock, with at least one tracked variant at zero stock or below",
  "contact-with-purchasing-tag":
    "Has contact together with instock or clearance; the purchasing tag takes priority",
  "clearance-continues-selling":
    "Clearance variant already permits selling past zero stock",
  "clearance-not-tracked": "Clearance variant has inventory tracking disabled",
  "purchasable-with-hidden-price":
    "Purchasing is enabled but noprice hides the displayed price",
  "tag-capitalization-review": "A control tag has unexpected capitalization",
};
export function reportMarkdown(plan, hash) {
  const s = summary(plan);
  const rows = Object.entries(s.byStatus)
    .map(
      ([status, x]) =>
        `| ${status} | ${x.products} | ${x.productsAffected} | ${x.variantPoliciesToChange} | ${x.contactTagsToRemove} |`,
    )
    .join("\n");
  const flagged = plan.snapshot.products.filter((p) => flagsFor(p).length);
  return `# Abode product update — dry run\n\nNo product data was changed.\n\nStore: ${STORE}\n\nCaptured: ${plan.snapshot.capturedAt}\n\nAPI: ${API_VERSION}\n\nPlan SHA-256: \`${hash}\`\n\n## Proposed changes\n\n- Read ${s.products} products and ${s.variants} variants, including drafts and archived products.\n- Change ${s.variantPoliciesToChange} variants to continue selling when out of stock.\n- Remove contact from ${s.contactTagsToRemove} products.\n- ${s.productsAffected} products have at least one proposed data change.\n- Leave inventory policies unchanged on all ${s.clearanceProducts} clearance products.\n\n| Status | Products read | Products affected | Variant policy changes | Contact tags removed |\n| --- | ---: | ---: | ---: | ---: |\n${rows}\n\n## Review flags\n\nFlags can overlap. An instock zero-stock flag means at least one tracked variant is at zero or below; it does not mean all variants are sold out.\n\n${Object.entries(
    s.flags,
  )
    .map(
      ([key, count]) =>
        `- ${flagLabels[key] || key}: ${count} ${count === 1 ? "product" : "products"}`,
    )
    .join(
      "\n",
    )}\n\nSee products.csv for every product and its review flags; variant-changes.csv lists each proposed policy change. See plan.json for exact IDs and old/new values, and backup.json for the full pre-change snapshot.\n\n## Before applying\n\nThe live theme must use the new tag rules before removing contact. Review other apps/collection rules/workflows that depend on contact. Continuing to sell allows zero-stock instock products to remain purchasable and display In stock. New products and later clearance-tag changes need ongoing maintenance. No quantities, prices, tracking settings, publication status or other tags are part of this update.\n\n## Flagged active products with storefront URLs\n\n${flagged
    .filter((p) => p.status === "ACTIVE" && p.onlineStoreUrl)
    .map(
      (p) =>
        `- [${p.title.replaceAll("[", "(").replaceAll("]", ")")}](${p.onlineStoreUrl}): ${flagsFor(
          p,
        )
          .map((flag) => flagLabels[flag] || flag)
          .join("; ")}`,
    )
    .join("\n")}\n`;
}
export async function main(args = process.argv.slice(2), dependencies = {}) {
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/product-ordering/run.mjs [--mode dry-run|apply|verify|rollback] [--out DIRECTORY]\nDefault: dry-run. See scripts/product-ordering/README.md for write-mode safeguards.",
    );
    return;
  }
  const opts = options(args),
    client = dependencies.client ?? new Shopify({ write: opts.write });
  let plan, hash, dir;
  if (opts.plan) {
    plan = load(opts.plan);
    hash = opts.checksum;
    validatePlan(plan, hash);
    dir = path.dirname(path.resolve(opts.plan));
  }
  if (["dry-run", "plan"].includes(opts.mode)) {
    ensure(
      !opts.plan && !opts.checksum,
      "Dry run creates a fresh plan; do not supply an old plan",
    );
    dir = path.resolve(
      opts.out ||
        `output/product-ordering/${new Date().toISOString().replaceAll(":", "-")}`,
    );
    ensure(
      !existsSync(path.join(dir, "plan.json")),
      "Output already contains a plan; choose a new directory",
    );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "run.lock");
  const lockFd = openSync(lock, "wx", 0o600);
  writeSync(lockFd, `${process.pid}\n`);
  closeSync(lockFd);
  try {
    await client.auth();
    await client.identity();
    if (["dry-run", "plan"].includes(opts.mode)) {
      const snapshot = await client.snapshot();
      plan = makePlan(snapshot);
      hash = checksum(plan);
      save(path.join(dir, "backup.json"), snapshot);
      save(path.join(dir, "plan.json"), plan);
      writeFileSync(path.join(dir, "plan.sha256"), hash + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      const csv = reports(plan);
      writeFileSync(path.join(dir, "products.csv"), csv.products, {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(path.join(dir, "variant-changes.csv"), csv.variants, {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(path.join(dir, "review.md"), reportMarkdown(plan, hash), {
        flag: "wx",
        mode: 0o600,
      });
      save(path.join(dir, "summary.json"), summary(plan));
      console.log(
        JSON.stringify(
          { mode: "dry-run", directory: dir, checksum: hash, ...summary(plan) },
          null,
          2,
        ),
      );
      return;
    }
    if (opts.mode === "verify") {
      const current = await client.snapshot();
      const differences = compareCatalog(expectedProducts(plan), current);
      const result = {
        mode: "verify",
        checkedAt: new Date().toISOString(),
        planHash: hash,
        matchesIntendedState: differences.length === 0,
        differences,
      };
      save(
        path.join(dir, `verification-${Date.now()}-${randomUUID()}.json`),
        result,
      );
      console.log(JSON.stringify(result, null, 2));
      if (differences.length) process.exitCode = 2;
      return;
    }
    const journal = path.join(dir, "journal.jsonl");
    let rows = journalRows(journal, hash);
    // A confirmed API response can be reconciled. A missing response cannot prove ownership.
    for (const entry of rows.filter((r) => r.phase === "prepared")) {
      if (rows.some((r) => r.key === entry.key && r.phase === "confirmed"))
        continue;
      ensure(
        rows.some((r) => r.key === entry.key && r.phase === "acknowledged"),
        `Unresolved request ${entry.key}. Inspect current state and journal before any further writes; do not delete journal entries to retry.`,
      );
      const current = await client.product(entry.action.productId);
      ensure(
        same(guardState(current), entry.after),
        `Acknowledged request has conflicting current state: ${entry.key}`,
      );
      append(
        journal,
        { phase: "confirmed", key: entry.key, reconciled: true },
        hash,
      );
    }
    rows = journalRows(journal, hash);
    const prepared = new Map(
      rows.filter((r) => r.phase === "prepared").map((r) => [r.key, r]),
    );
    const done = rows
      .filter((r) => r.phase === "confirmed")
      .map((r) => prepared.get(r.key));
    ensure(done.every(Boolean), "Journal is incomplete");
    if (opts.mode === "apply")
      ensure(
        !done.some((r) => r.key.startsWith("rollback:")),
        "This run has been rolled back; create a fresh dry run",
      );
    const expected = new Map(
      plan.snapshot.products.map((p) => [p.id, structuredClone(p)]),
    );
    for (const entry of done)
      expected.set(
        entry.action.productId,
        applyAction(expected.get(entry.action.productId), entry.action),
      );
    const drift = compareCatalog(expected, await client.snapshot());
    ensure(
      !drift.length,
      `Catalog differs from the saved plan/journal (${drift.length} products). Run verify and review before continuing.`,
    );
    const completedKeys = new Set(done.map((r) => r.key));
    const actions =
      opts.mode === "apply"
        ? actionsFor(plan)
        : done
            .filter((r) => !r.key.startsWith("rollback:"))
            .reverse()
            .map(inverse);
    let changed = 0;
    for (const action of actions) {
      if (completedKeys.has(action.key)) continue;
      const before = expected.get(action.productId),
        current = await client.product(action.productId);
      ensure(
        same(guardState(before), guardState(current)),
        `Concurrent product change: ${action.productId}. Stopping.`,
      );
      if (opts.mode === "apply" && action.kind === "policies")
        ensure(
          !current.tags.includes("clearance"),
          "Product is now clearance; stopping",
        );
      const after = applyAction(before, action);
      append(
        journal,
        {
          phase: "prepared",
          key: action.key,
          action,
          before: guardState(before),
          after: guardState(after),
        },
        hash,
      );
      try {
        await client.mutate(action);
        append(journal, { phase: "acknowledged", key: action.key }, hash);
        ensure(
          same(
            guardState(await client.product(action.productId)),
            guardState(after),
          ),
          `Post-write verification failed: ${action.productId}`,
        );
        append(journal, { phase: "confirmed", key: action.key }, hash);
      } catch (error) {
        append(
          journal,
          {
            phase: "failed",
            key: action.key,
            message:
              "Request or verification failed; reconcile before resuming.",
          },
          hash,
        );
        throw error;
      }
      expected.set(action.productId, after);
      changed++;
      console.error(`${opts.mode}: confirmed ${changed} actions`);
    }
    const differences = compareCatalog(expected, await client.snapshot());
    const result = {
      mode: opts.mode,
      finishedAt: new Date().toISOString(),
      planHash: hash,
      actionsCompletedThisRun: changed,
      differences,
    };
    save(
      path.join(dir, `${opts.mode}-result-${Date.now()}-${randomUUID()}.json`),
      result,
    );
    ensure(
      !differences.length,
      "Final verification found differences; inspect the saved result",
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  });
