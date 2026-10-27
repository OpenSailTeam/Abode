import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  operations,
  mutationNames,
  API_VERSION,
  STORE,
} from "./operations.mjs";
import { ensure, assertShop, assertSnapshot, same } from "./model.mjs";
const exec = promisify(execFile);
export function cliEnvironment(env = process.env) {
  // Never inherit CLI flags that could override the store, query or mutation guard.
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("SHOPIFY_FLAG_")),
  );
}
export class Shopify {
  constructor({ write = false, run = exec, pause = sleep } = {}) {
    this.write = write;
    this.run = run;
    this.pause = pause;
  }
  async command(args) {
    const { stdout } = await this.run("shopify", args, {
      env: cliEnvironment(),
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    if (result?.error) throw new Error(JSON.stringify(result.error));
    if (result?.errors?.length) throw new Error(JSON.stringify(result.errors));
    return result;
  }
  async auth() {
    const scopes = this.write
      ? ["read_products", "read_inventory", "write_products"]
      : ["read_products", "read_inventory"];
    const { sessions } = await this.command([
      "store",
      "auth",
      "list",
      "--json",
    ]);
    const session = sessions?.find((s) => s.store === STORE);
    ensure(
      session &&
        Date.parse(session.expiresAt) > Date.now() &&
        scopes.every(
          (scope) =>
            session.scopes.includes(scope) ||
            session.scopes.includes(scope.replace(/^read_/, "write_")),
        ),
      `Authenticate first: shopify store auth --store ${STORE} --scopes ${scopes.join(",")}`,
    );
  }
  async query(name, variables = {}) {
    ensure(Object.hasOwn(operations, name), "Unknown operation");
    const mutation = mutationNames.has(name);
    ensure(
      !mutation || this.write,
      "Mutations are disabled in dry-run and verify modes",
    );
    const args = [
      "store",
      "execute",
      "--store",
      STORE,
      "--version",
      API_VERSION,
      "--json",
      "--no-input",
      "--query",
      operations[name],
      "--variables",
      JSON.stringify(variables),
    ];
    if (mutation) args.push("--allow-mutations");
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.command(args);
        const throttle = result?.extensions?.cost?.throttleStatus;
        const wait =
          throttle?.restoreRate > 0
            ? Math.max(
                250,
                ((500 - throttle.currentlyAvailable) / throttle.restoreRate) *
                  1000,
              )
            : 250;
        await this.pause(Math.min(30000, wait));
        return result?.data ?? result;
      } catch (error) {
        const details = [error.message, error.stderr, error.stdout].join(" ");
        // Never blindly retry a write: an interrupted request may have succeeded.
        if (
          mutation ||
          attempt >= 4 ||
          !/throttl|429|502|503|504|ECONNRESET|ETIMEDOUT|fetch failed|EAI_AGAIN/i.test(
            details,
          )
        )
          throw error;
        await this.pause(Math.min(30000, 2000 * 2 ** attempt));
      }
    }
  }
  async identity() {
    const data = await this.query("identity");
    assertShop(data.shop);
    ensure(
      data.productsCount?.precision === "EXACT" &&
        data.productVariantsCount?.precision === "EXACT",
      "Catalog counts are not exact",
    );
    return data;
  }
  async pages(name, key) {
    const nodes = [];
    let after = null;
    const cursors = new Set(),
      ids = new Set();
    for (;;) {
      const data = await this.query(name, { after }),
        connection = data[key];
      ensure(
        Array.isArray(connection?.nodes) &&
          typeof connection.pageInfo?.hasNextPage === "boolean",
        "Incomplete pagination response",
      );
      for (const node of connection.nodes) {
        ensure(!ids.has(node.id), "Duplicate ID during pagination");
        ids.add(node.id);
        nodes.push(node);
      }
      if (!connection.pageInfo.hasNextPage) return nodes;
      const next = connection.pageInfo.endCursor;
      ensure(
        next && !cursors.has(next) && connection.nodes.length,
        "Pagination did not advance",
      );
      cursors.add(next);
      after = next;
    }
  }
  async snapshot() {
    const startedAt = new Date().toISOString();
    const start = await this.identity();
    console.error(
      "Reading all products and variants (including drafts and archived products)…",
    );
    const products = await this.pages("products", "products");
    const variants = await this.pages("variants", "productVariants");
    const productsAgain = await this.pages("products", "products");
    const end = await this.identity();
    ensure(
      same(start, end) && same(products, productsAgain),
      "Catalog changed during export. Run a new dry run.",
    );
    const index = new Map(products.map((p) => [p.id, { ...p, variants: [] }]));
    for (const { product, ...v } of variants) {
      ensure(index.has(product.id), "Variant references an unexported product");
      index.get(product.id).variants.push(v);
    }
    const snapshot = {
      shop: start.shop,
      startedAt,
      capturedAt: new Date().toISOString(),
      counts: {
        products: start.productsCount.count,
        variants: start.productVariantsCount.count,
      },
      products: [...index.values()],
    };
    assertSnapshot(snapshot);
    return snapshot;
  }
  async product(id) {
    let after = null,
      result = null;
    const cursors = new Set();
    for (;;) {
      const data = await this.query("product", { id, after });
      ensure(data.product, `Product missing: ${id}`);
      const { variants, ...p } = data.product;
      if (!result) result = { ...p, variants: [] };
      else
        ensure(
          same(
            { ...result, variants: undefined },
            { ...p, variants: undefined },
          ),
          "Product changed during variant pagination",
        );
      result.variants.push(...variants.nodes);
      if (!variants.pageInfo.hasNextPage) break;
      after = variants.pageInfo.endCursor;
      ensure(
        after && !cursors.has(after) && variants.nodes.length,
        "Product pagination did not advance",
      );
      cursors.add(after);
    }
    ensure(
      result.variantsCount.precision === "EXACT" &&
        result.variants.length === result.variantsCount.count &&
        new Set(result.variants.map((v) => v.id)).size ===
          result.variants.length,
      "Incomplete product variants",
    );
    return result;
  }
  async mutate(action) {
    const data = await this.query(action.kind, {
      id: action.productId,
      ...(action.kind === "policies" ? { variants: action.variants } : {}),
    });
    const key = {
      policies: "productVariantsBulkUpdate",
      removeContact: "tagsRemove",
      restoreContact: "tagsAdd",
    }[action.kind];
    ensure(
      data[key] && Array.isArray(data[key].userErrors),
      "Missing mutation result",
    );
    ensure(!data[key].userErrors.length, JSON.stringify(data[key].userErrors));
    if (action.kind === "policies")
      ensure(
        same(
          data[key].productVariants
            .map((v) => ({ id: v.id, inventoryPolicy: v.inventoryPolicy }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          [...action.variants].sort((a, b) => a.id.localeCompare(b.id)),
        ),
        "Mutation result did not match requested policies",
      );
    else
      ensure(
        data[key].node?.id === action.productId,
        "Mutation returned the wrong product",
      );
  }
}
