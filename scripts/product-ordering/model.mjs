import { createHash } from "node:crypto";
import { API_VERSION, STORE, SHOP_ID } from "./operations.mjs";
export const canonical = (value) => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize(value[k])]),
    );
  return value;
}
export const checksum = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const sorted = (values) => [...values].sort();
export const same = (a, b) => canonical(a) === canonical(b);
export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
export function assertShop(shop) {
  ensure(
    shop?.id === SHOP_ID && shop?.myshopifyDomain === STORE,
    "Wrong Shopify store. Refusing to proceed.",
  );
}
export function assertSnapshot(snapshot) {
  assertShop(snapshot.shop);
  const ids = new Set();
  const variants = new Set();
  for (const p of snapshot.products) {
    ensure(
      !ids.has(p.id) && p.id.startsWith("gid://shopify/Product/"),
      "Invalid or duplicate product ID",
    );
    ids.add(p.id);
    ensure(
      Array.isArray(p.tags) && p.tags.every((t) => typeof t === "string"),
      `Invalid tags: ${p.id}`,
    );
    ensure(
      p.variantsCount.precision === "EXACT" &&
        p.variantsCount.count === p.variants.length,
      `Incomplete variants: ${p.id}`,
    );
    for (const v of p.variants) {
      ensure(
        !variants.has(v.id) && v.id.startsWith("gid://shopify/ProductVariant/"),
        "Invalid or duplicate variant ID",
      );
      variants.add(v.id);
      ensure(
        ["DENY", "CONTINUE"].includes(v.inventoryPolicy) &&
          typeof v.inventoryItem?.tracked === "boolean",
        `Missing variant data: ${v.id}`,
      );
    }
  }
  ensure(
    snapshot.counts.products === ids.size &&
      snapshot.counts.variants === variants.size,
    "Catalog totals do not match exported records",
  );
}
export function changesFor(products) {
  return products
    .map((p) => ({
      productId: p.id,
      policies: p.tags.includes("clearance")
        ? []
        : p.variants
            .filter((v) => v.inventoryPolicy !== "CONTINUE")
            .map((v) => ({
              id: v.id,
              before: v.inventoryPolicy,
              after: "CONTINUE",
            })),
      removeContact: p.tags.includes("contact"),
    }))
    .filter((c) => c.policies.length || c.removeContact);
}
export function flagsFor(p) {
  const tags = new Set(p.tags),
    buy = tags.has("instock") || tags.has("clearance");
  const flags = [];
  if (
    tags.has("clearance") &&
    p.variants.some((v) => v.inventoryPolicy === "CONTINUE")
  )
    flags.push("clearance-continues-selling");
  if (tags.has("clearance") && p.variants.some((v) => !v.inventoryItem.tracked))
    flags.push("clearance-not-tracked");
  if (
    tags.has("instock") &&
    p.variants.some((v) => v.inventoryItem.tracked && v.inventoryQuantity <= 0)
  )
    flags.push("instock-zero-stock-variant");
  if (tags.has("contact") && buy) flags.push("contact-with-purchasing-tag");
  if (tags.has("noprice") && buy) flags.push("purchasable-with-hidden-price");
  if (!tags.has("contact") && !buy) flags.push("new-order-only-behavior");
  if (
    p.tags.some(
      (t) =>
        ["contact", "instock", "clearance"].includes(t.toLowerCase()) &&
        t !== t.toLowerCase(),
    )
  )
    flags.push("tag-capitalization-review");
  return flags;
}
export function makePlan(snapshot) {
  assertSnapshot(snapshot);
  return {
    format: 1,
    apiVersion: API_VERSION,
    createdAt: new Date().toISOString(),
    snapshot,
    changes: changesFor(snapshot.products),
  };
}
export function validatePlan(plan, expectedHash) {
  ensure(
    plan.format === 1 && plan.apiVersion === API_VERSION,
    "Unsupported plan version",
  );
  ensure(
    checksum(plan) === expectedHash,
    "Plan checksum does not match the reviewed checksum",
  );
  assertSnapshot(plan.snapshot);
  ensure(
    same(plan.changes, changesFor(plan.snapshot.products)),
    "Plan changes do not match the allowed migration rules",
  );
}
// Fields that must not drift while applying. Quantities can change through normal sales.
export function guardState(p) {
  return {
    id: p.id,
    status: p.status,
    tags: sorted(p.tags),
    variants: p.variants
      .map((v) => ({
        id: v.id,
        inventoryPolicy: v.inventoryPolicy,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inventoryItem: v.inventoryItem,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function applyAction(product, action) {
  const p = structuredClone(product);
  if (action.kind === "policies") {
    for (const change of action.variants) {
      const v = p.variants.find((v) => v.id === change.id);
      ensure(v, "Variant missing from action");
      v.inventoryPolicy = change.inventoryPolicy;
    }
  } else if (action.kind === "removeContact")
    p.tags = p.tags.filter((t) => t !== "contact");
  else if (action.kind === "restoreContact")
    p.tags = [...new Set([...p.tags, "contact"])];
  else throw new Error("Unknown action");
  return p;
}
export function actionsFor(plan) {
  const actions = [];
  for (const c of plan.changes) {
    for (let i = 0; i < c.policies.length; i += 250)
      actions.push({
        key: `${c.productId}:policies:${i}`,
        productId: c.productId,
        kind: "policies",
        variants: c.policies
          .slice(i, i + 250)
          .map((v) => ({ id: v.id, inventoryPolicy: v.after })),
      });
    if (c.removeContact)
      actions.push({
        key: `${c.productId}:contact`,
        productId: c.productId,
        kind: "removeContact",
      });
  }
  return actions;
}
export function expectedProducts(plan) {
  const products = new Map(
    plan.snapshot.products.map((p) => [p.id, structuredClone(p)]),
  );
  for (const action of actionsFor(plan))
    products.set(
      action.productId,
      applyAction(products.get(action.productId), action),
    );
  return products;
}
export function compareCatalog(expected, actual) {
  const problems = [];
  for (const p of actual.products) {
    const before = expected.get(p.id);
    if (!before) problems.push({ id: p.id, issue: "new-product" });
    else if (!same(guardState(before), guardState(p)))
      problems.push({
        id: p.id,
        title: p.title,
        issue: "tags-status-variants-policy-price-or-tracking-differ",
      });
  }
  const actualIds = new Set(actual.products.map((p) => p.id));
  for (const id of expected.keys())
    if (!actualIds.has(id)) problems.push({ id, issue: "missing-product" });
  return problems;
}
export function summary(plan) {
  const result = {
    products: plan.snapshot.products.length,
    variants: plan.snapshot.counts.variants,
    productsAffected: plan.changes.length,
    variantPoliciesToChange: 0,
    contactTagsToRemove: 0,
    clearanceProducts: 0,
    byStatus: {},
    flags: {},
  };
  const changes = new Map(plan.changes.map((c) => [c.productId, c]));
  for (const p of plan.snapshot.products) {
    const c = changes.get(p.id);
    const bucket = (result.byStatus[p.status] ??= {
      products: 0,
      productsAffected: 0,
      variantPoliciesToChange: 0,
      contactTagsToRemove: 0,
    });
    bucket.products++;
    if (c) {
      bucket.productsAffected++;
      bucket.variantPoliciesToChange += c.policies.length;
      bucket.contactTagsToRemove += Number(c.removeContact);
      result.variantPoliciesToChange += c.policies.length;
      result.contactTagsToRemove += Number(c.removeContact);
    }
    if (p.tags.includes("clearance")) result.clearanceProducts++;
    for (const flag of flagsFor(p))
      result.flags[flag] = (result.flags[flag] || 0) + 1;
  }
  return result;
}
export function csv(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            let s = String(value ?? "");
            if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\n") + "\n"
  );
}
export function reports(plan) {
  const products = [
    [
      "Product ID",
      "Title",
      "Handle",
      "Status",
      "Online store URL",
      "Tags before",
      "Tags after",
      "Variant policies to change",
      "Remove contact",
      "Review flags",
    ],
  ];
  const variants = [
    [
      "Product ID",
      "Title",
      "Status",
      "Variant ID",
      "Variant",
      "SKU",
      "Tracked",
      "Quantity",
      "Policy before",
      "Policy after",
    ],
  ];
  const changes = new Map(plan.changes.map((c) => [c.productId, c]));
  for (const p of plan.snapshot.products) {
    const c = changes.get(p.id);
    products.push([
      p.id,
      p.title,
      p.handle,
      p.status,
      p.onlineStoreUrl,
      p.tags.join("; "),
      p.tags.filter((t) => t !== "contact").join("; "),
      c?.policies.length || 0,
      Boolean(c?.removeContact),
      flagsFor(p).join("; "),
    ]);
    for (const change of c?.policies || []) {
      const v = p.variants.find((v) => v.id === change.id);
      variants.push([
        p.id,
        p.title,
        p.status,
        v.id,
        v.title,
        v.sku,
        v.inventoryItem.tracked,
        v.inventoryQuantity,
        change.before,
        change.after,
      ]);
    }
  }
  return { products: csv(products), variants: csv(variants) };
}
