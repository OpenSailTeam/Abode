import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STORE, SHOP_ID, operations, mutationNames } from "./operations.mjs";
import {
  makePlan,
  checksum,
  validatePlan,
  summary,
  flagsFor,
  actionsFor,
  guardState,
  applyAction,
  compareCatalog,
  expectedProducts,
  csv,
} from "./model.mjs";
import { Shopify, cliEnvironment } from "./shopify.mjs";
import { main, options } from "./run.mjs";
const variant = (id, policy = "DENY") => ({
  id: `gid://shopify/ProductVariant/${id}`,
  title: "Default",
  sku: "SKU",
  inventoryPolicy: policy,
  inventoryQuantity: 0,
  availableForSale: false,
  updatedAt: "2026-10-27T00:00:00Z",
  price: "100.00",
  compareAtPrice: null,
  inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, tracked: true },
});
const product = (id, tags, variants = [variant(id)], status = "ACTIVE") => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  handle: `product-${id}`,
  tags,
  status,
  updatedAt: "2026-10-27T00:00:00Z",
  onlineStoreUrl: `https://abodefurnishings.ca/products/product-${id}`,
  variantsCount: { count: variants.length, precision: "EXACT" },
  variants,
});
const snapshot = () => ({
  shop: { id: SHOP_ID, myshopifyDomain: STORE, name: "Abode" },
  capturedAt: "2026-10-27T00:00:00Z",
  counts: { products: 5, variants: 6 },
  products: [
    product(1, ["all", "contact"]),
    product(2, ["instock"], [variant(2), variant(3, "CONTINUE")]),
    product(3, ["clearance", "contact"], [variant(4)]),
    product(4, ["clearance", "instock"], [variant(5, "CONTINUE")]),
    product(5, ["all"], [variant(6)], "ARCHIVED"),
  ],
});
const temp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "abode-script-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function fake(snapshotData = snapshot()) {
  let state = structuredClone(snapshotData);
  const calls = [];
  return {
    calls,
    auth: async () => {},
    identity: async () => ({ shop: state.shop }),
    snapshot: async () => structuredClone(state),
    product: async (id) =>
      structuredClone(state.products.find((p) => p.id === id)),
    mutate: async (action) => {
      calls.push(action);
      state.products = state.products.map((p) =>
        p.id === action.productId ? applyAction(p, action) : p,
      );
    },
    state: () => structuredClone(state),
  };
}
function writePlan(dir) {
  const plan = makePlan(snapshot());
  const file = path.join(dir, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  return { plan, file, hash: checksum(plan) };
}
function writeArgs(mode, file, hash) {
  return [
    "--mode",
    mode,
    "--plan",
    file,
    "--checksum",
    hash,
    "--confirm-store",
    STORE,
    "--theme-ready",
    "--dependencies-reviewed",
    "--products-paused",
  ];
}

test("plans all statuses, skips existing CONTINUE, preserves clearance policies, removes only contact", () => {
  const p = makePlan(snapshot());
  const s = summary(p);
  assert.equal(s.variantPoliciesToChange, 3);
  assert.equal(s.contactTagsToRemove, 2);
  assert.equal(s.productsAffected, 4);
  const expected = expectedProducts(p);
  assert.equal(
    expected.get("gid://shopify/Product/3").variants[0].inventoryPolicy,
    "DENY",
  );
  assert.equal(
    expected.get("gid://shopify/Product/4").variants[0].inventoryPolicy,
    "CONTINUE",
  );
  assert.deepEqual(expected.get("gid://shopify/Product/1").tags, ["all"]);
  assert.equal(
    expected.get("gid://shopify/Product/5").variants[0].inventoryPolicy,
    "CONTINUE",
  );
});
test("checksum and recomputed rules reject altered or expanded plans", () => {
  const p = makePlan(snapshot());
  const h = checksum(p);
  validatePlan(p, h);
  p.changes[0].policies[0].after = "DENY";
  assert.throws(() => validatePlan(p, h), /checksum/);
  assert.throws(() => validatePlan(p, checksum(p)), /allowed migration rules/);
});
test("wrong shop, missing variants, and duplicate variants fail closed", () => {
  const s = snapshot();
  s.shop.id = "gid://shopify/Shop/1";
  assert.throws(() => makePlan(s), /Wrong Shopify/);
  const missing = snapshot();
  missing.products[1].variants.pop();
  assert.throws(() => makePlan(missing), /Incomplete variants/);
  const duplicate = snapshot();
  duplicate.products[2].variants[0].id = duplicate.products[0].variants[0].id;
  assert.throws(() => makePlan(duplicate), /duplicate variant/);
});
test("batches more than 250 variants and leaves tag removal last", () => {
  const s = snapshot();
  s.products = [
    product(
      1,
      ["contact"],
      Array.from({ length: 503 }, (_, i) => variant(i + 1)),
    ),
  ];
  s.counts = { products: 1, variants: 503 };
  const a = actionsFor(makePlan(s));
  assert.deepEqual(
    a.slice(0, 3).map((a) => a.variants.length),
    [250, 250, 3],
  );
  assert.equal(a[3].kind, "removeContact");
});
test("review flags distinguish stock quantity, no-price, tag collisions and clearance exceptions", () => {
  const p = product(
    1,
    ["instock", "clearance", "contact", "noprice", "Contact"],
    [variant(1, "CONTINUE")],
  );
  p.variants.push({
    ...variant(2),
    inventoryItem: { id: "i2", tracked: false },
  });
  const flags = flagsFor(p);
  for (const flag of [
    "clearance-continues-selling",
    "clearance-not-tracked",
    "instock-zero-stock-variant",
    "contact-with-purchasing-tag",
    "purchasable-with-hidden-price",
    "tag-capitalization-review",
  ])
    assert.ok(flags.includes(flag));
});
test("CSV escapes quotes and prevents formula interpretation", () => {
  assert.equal(
    csv([['=HYPERLINK("x")', "A,B"]]),
    '"\'=HYPERLINK(""x"")","A,B"\n',
  );
});
test("dry run is default; unknown flags and missing write confirmations fail", () => {
  assert.equal(options([]).write, false);
  assert.throws(() => options(["--apply"]));
  assert.throws(() => options(["--mode", "apply"]), /saved plan/);
  assert.throws(() => options(["--mode", "unknown"]));
  assert.throws(
    () =>
      options([
        "--mode",
        "apply",
        "--plan",
        "x",
        "--checksum",
        "a".repeat(64),
        "--confirm-store",
        "wrong",
      ]),
    /Abode/,
  );
});
test("transport blocks all mutations in read-only mode and strips ambient CLI flags", async () => {
  let calls = 0;
  const client = new Shopify({
    run: async () => {
      calls++;
    },
    pause: async () => {},
  });
  for (const name of mutationNames)
    await assert.rejects(client.query(name, {}), /Mutations are disabled/);
  assert.equal(calls, 0);
  assert.deepEqual(
    cliEnvironment({
      PATH: "safe",
      SHOPIFY_FLAG_ALLOW_MUTATIONS: "1",
      SHOPIFY_FLAG_STORE: "wrong",
      SHOPIFY_FLAG_QUERY: "mutation { x }",
    }),
    { PATH: "safe" },
  );
});
test("reads pin the store/version and never pass allow-mutations", async () => {
  let args;
  const client = new Shopify({
    run: async (exe, a) => {
      assert.equal(exe, "shopify");
      args = a;
      return {
        stdout: JSON.stringify({
          shop: { id: SHOP_ID, myshopifyDomain: STORE },
          productsCount: { count: 0, precision: "EXACT" },
          productVariantsCount: { count: 0, precision: "EXACT" },
        }),
      };
    },
    pause: async () => {},
  });
  await client.identity();
  assert.ok(args.includes(STORE));
  assert.ok(args.includes("2026-10"));
  assert.ok(!args.includes("--allow-mutations"));
});
test("read retries are bounded, writes are never blindly retried", async () => {
  let reads = 0;
  const read = new Shopify({
    run: async () => {
      reads++;
      throw new Error("503");
    },
    pause: async () => {},
  });
  await assert.rejects(read.query("identity"));
  assert.equal(reads, 5);
  let writes = 0;
  const write = new Shopify({
    write: true,
    run: async () => {
      writes++;
      throw new Error("503");
    },
    pause: async () => {},
  });
  await assert.rejects(write.query("removeContact", { id: "x" }));
  assert.equal(writes, 1);
});
test("GraphQL errors and mutation userErrors abort", async () => {
  const gql = new Shopify({
    run: async () => ({
      stdout: JSON.stringify({ data: {}, errors: [{ message: "bad" }] }),
    }),
    pause: async () => {},
  });
  await assert.rejects(gql.query("identity"), /bad/);
  const client = new Shopify({
    write: true,
    run: async () => ({
      stdout: JSON.stringify({
        tagsRemove: { userErrors: [{ message: "denied" }], node: null },
      }),
    }),
    pause: async () => {},
  });
  await assert.rejects(
    client.mutate({ kind: "removeContact", productId: "x" }),
    /denied/,
  );
});
test("pagination reads every page and rejects stuck cursors or duplicate records", async () => {
  const c = new Shopify();
  let i = 0;
  c.query = async () => ({
    products: {
      nodes: [{ id: String(i++) }],
      pageInfo: { hasNextPage: i < 3, endCursor: String(i) },
    },
  });
  assert.equal((await c.pages("products", "products")).length, 3);
  c.query = async () => ({
    products: {
      nodes: [{ id: "repeat" }],
      pageInfo: { hasNextPage: true, endCursor: "same" },
    },
  });
  await assert.rejects(c.pages("products", "products"), /Duplicate/);
});
test("per-product pagination includes variants beyond 250", async () => {
  const c = new Shopify();
  const p = product(
    1,
    [],
    Array.from({ length: 251 }, (_, i) => variant(i)),
  );
  c.query = async (name, { after }) => ({
    product: {
      ...p,
      variants: {
        nodes: after ? p.variants.slice(250) : p.variants.slice(0, 250),
        pageInfo: { hasNextPage: !after, endCursor: "next" },
      },
    },
  });
  assert.equal((await c.product(p.id)).variants.length, 251);
});
test("catalog changes during the snapshot abort instead of producing a plan", async () => {
  const c = new Shopify();
  c.identity = async () => ({ shop: { id: SHOP_ID, myshopifyDomain: STORE } });
  let n = 0;
  c.pages = async (name) => (name === "products" ? [{ id: String(n++) }] : []);
  await assert.rejects(c.snapshot(), /changed during export/);
});
test("dry run writes review files and does not invoke a mutation", async (t) => {
  const dir = temp(t),
    client = fake();
  await main(["--out", dir], { client });
  assert.equal(client.calls.length, 0);
  for (const name of [
    "plan.json",
    "backup.json",
    "summary.json",
    "review.md",
    "products.csv",
    "variant-changes.csv",
    "plan.sha256",
  ])
    assert.ok(existsSync(path.join(dir, name)));
  assert.ok(!existsSync(path.join(dir, "journal.jsonl")));
  assert.ok(!existsSync(path.join(dir, "run.lock")));
});
test("apply is restartable and rollback restores only the successful run changes", async (t) => {
  const dir = temp(t),
    { file, hash, plan } = writePlan(dir),
    client = fake();
  await main(writeArgs("apply", file, hash), { client });
  assert.equal(
    compareCatalog(expectedProducts(plan), client.state()).length,
    0,
  );
  assert.equal(client.calls.length, 5);
  await main(writeArgs("apply", file, hash), { client });
  assert.equal(client.calls.length, 5);
  await main(writeArgs("rollback", file, hash), { client });
  assert.deepEqual(
    client.state().products.map(guardState),
    snapshot().products.map(guardState),
  );
  assert.equal(client.calls.length, 10);
  await main(writeArgs("rollback", file, hash), { client });
  assert.equal(client.calls.length, 10);
});
test("a new clearance tag or other concurrent edits prevent writes", async (t) => {
  const dir = temp(t),
    { file, hash } = writePlan(dir),
    s = snapshot();
  s.products[0].tags.push("clearance");
  const client = fake(s);
  await assert.rejects(
    main(writeArgs("apply", file, hash), { client }),
    /differs from the saved plan/,
  );
  assert.equal(client.calls.length, 0);
});
test("unknown mutation outcome blocks further apply and rollback rather than guessing ownership", async (t) => {
  const dir = temp(t),
    { file, hash } = writePlan(dir),
    client = fake();
  const mutate = client.mutate;
  client.mutate = async (a) => {
    await mutate(a);
    throw new Error("connection lost after write");
  };
  await assert.rejects(
    main(writeArgs("apply", file, hash), { client }),
    /connection lost/,
  );
  assert.equal(client.calls.length, 1);
  client.mutate = mutate;
  await assert.rejects(
    main(writeArgs("apply", file, hash), { client }),
    /Unresolved request/,
  );
  await assert.rejects(
    main(writeArgs("rollback", file, hash), { client }),
    /Unresolved request/,
  );
  assert.equal(client.calls.length, 1);
});
test("read-only verify detects catalog drift without mutating", async (t) => {
  const dir = temp(t),
    { file, hash } = writePlan(dir),
    client = fake();
  await main(["--mode", "verify", "--plan", file, "--checksum", hash], {
    client,
  });
  assert.equal(client.calls.length, 0);
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
});
test("an acknowledged write with interrupted verification is reconciled without repeating it", async (t) => {
  const dir = temp(t),
    { file, hash } = writePlan(dir),
    client = fake();
  const read = client.product;
  let reads = 0;
  client.product = async (id) => {
    if (++reads === 2) throw new Error("verification read interrupted");
    return read(id);
  };
  await assert.rejects(
    main(writeArgs("apply", file, hash), { client }),
    /verification read interrupted/,
  );
  assert.equal(client.calls.length, 1);
  client.product = read;
  await main(writeArgs("apply", file, hash), { client });
  assert.equal(client.calls.length, 5);
});
test("a product change after catalog preflight is caught before a mutation", async (t) => {
  const dir = temp(t),
    { file, hash } = writePlan(dir),
    client = fake();
  const read = client.product;
  client.product = async (id) => {
    const p = await read(id);
    p.tags.push("clearance");
    return p;
  };
  await assert.rejects(
    main(writeArgs("apply", file, hash), { client }),
    /Concurrent product change/,
  );
  assert.equal(client.calls.length, 0);
});
test("rollback refuses to overwrite subsequent edits", async (t) => {
  const dir = temp(t),
    { file, hash } = writePlan(dir),
    client = fake();
  await main(writeArgs("apply", file, hash), { client });
  const changed = client.state();
  changed.products[0].tags.push("keep-my-edit");
  const other = fake(changed);
  await assert.rejects(
    main(writeArgs("rollback", file, hash), { client: other }),
    /differs from the saved plan/,
  );
  assert.equal(other.calls.length, 0);
});
