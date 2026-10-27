# Abode product ordering migration

A dependency-free Node script using the authenticated Shopify CLI. The store ID and domain are pinned to Abode. It defaults to a read-only dry run and includes active, draft, and archived products.

## Dry run

Use the project's NVM Node and an installed Shopify CLI with `store execute` support. Authenticate once (repeat when the session expires):

```sh
shopify store auth --store abode-furnishings-co.myshopify.com --scopes read_products,read_inventory
node scripts/product-ordering/run.mjs --mode dry-run
```

The script checks existing authentication metadata; it does not request new permissions automatically. All queries use Admin API `2026-10`. No write scopes or `--allow-mutations` are used for the dry run.

Each run creates a new ignored folder under `output/product-ordering/` containing:

- `review.md`: readable totals and exceptions, with product links.
- `products.csv`: every product, old/new tags, counts, and review flags.
- `variant-changes.csv`: each proposed variant policy change.
- `backup.json`: full catalog snapshot for the fields read by this script.
- `plan.json` and `plan.sha256`: exact proposed changes and checksum.
- `summary.json`: totals for automated checks.

Use `--out PATH` to choose a new output directory. Existing plans are never overwritten. Export reads products twice and checks exact product/variant counts to detect incomplete pagination or catalog changes during the read. Review flags include mixed-availability products: one zero-stock variant does not mean the whole product is sold out.

## Apply after review

Do not apply until the live theme uses the new stock/clearance rules, other dependencies on `contact` have been reviewed, and product editing is paused. Enabling continue-selling affects the store's shared product data, including other channels. This script changes no stock quantities or inventory-tracking settings.

After the dry run is approved, authenticate with write access:

```sh
shopify store auth --store abode-furnishings-co.myshopify.com --scopes read_products,read_inventory,write_products
```

Run apply with the reviewed plan path and the checksum printed in its report:

```sh
node scripts/product-ordering/run.mjs --mode apply \
  --plan PATH_TO_REVIEWED_PLAN_JSON \
  --checksum REVIEWED_SHA256 \
  --confirm-store abode-furnishings-co.myshopify.com \
  --theme-ready --dependencies-reviewed --products-paused
```

Those flags acknowledge real prerequisites; they are not substitutes for deploying the theme or reviewing dependencies. The write path has not been run against Abode as part of the dry run.

Apply rechecks the catalog and then each product immediately before changing it. It updates at most 250 variants per request with `allowPartialUpdates: false`, then removes only the `contact` tag. It stops on conflicts instead of guessing. It writes and flushes a journal before each request, records acknowledged responses, and confirms the resulting product fields before continuing. The API has no catalog-wide transaction or atomic tag precondition; pausing product editing limits the remaining race between checking and writing.

Successful actions are skipped on a repeat apply. Read requests use bounded retries for transient failures and throttling. Writes are never blindly retried. If a write has no confirmed response, the run stops for manual reconciliation; read current state and inspect `journal.jsonl` before deciding what happened. Do not erase or edit the journal to force a retry. A confirmed API response followed by an interrupted verification can be safely rechecked on resume.

## Verify or roll back

Read-only verification compares current state to the complete intended result:

```sh
node scripts/product-ordering/run.mjs --mode verify \
  --plan PATH_TO_REVIEWED_PLAN_JSON --checksum REVIEWED_SHA256
```

Exit code 0 means a match; 2 means differences; 1 means an execution error. Verification before apply will correctly show proposed changes as differences. It checks product/variant membership, status, tags, policies, prices, and tracking. Quantities and update timestamps are retained in the backup but excluded from equality checks because legitimate sales and inventory activity can change them.

Rollback reverses only acknowledged and verified changes from this plan's journal:

```sh
node scripts/product-ordering/run.mjs --mode rollback \
  --plan PATH_TO_REVIEWED_PLAN_JSON --checksum REVIEWED_SHA256 \
  --confirm-store abode-furnishings-co.myshopify.com --products-paused
```

It restores original variant policies and adds `contact` back only where this run removed it. It never replaces the entire tag list. Conflicting subsequent edits, missing records, or uncertain request outcomes stop the run for review. If rolling back the theme too, restore product data first. A rolled-back plan cannot be applied again; create a fresh dry run.

`run.lock` prevents overlapping modes in the same run directory. If a process is forcibly stopped, inspect whether it is still running and reconcile any prepared journal entry before removing a stale lock. Do not run separate migration plans concurrently. Keep the backup, plan, checksum, and journal together; the checksum detects accidental plan changes, not malicious editing of local files.

## Tests

```sh
node --test --test-isolation=none scripts/product-ordering/migration.test.mjs
```

Tests use fake API clients and temporary files, never the store. They cover read-only enforcement, plan tampering, clearance exclusions, pagination beyond 250 variants, tag preservation, resume, rollback, and ambiguous write failures.

## API references

- [Product variants](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/productVariants)
- [Variant inventory policies](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/ProductVariantInventoryPolicy)
- [Batch variant updates](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productVariantsBulkUpdate)
- [Remove specific tags](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsRemove)
- [Add specific tags](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd)
