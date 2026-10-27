# Abode product ordering update

Status: implemented in `scripts/product-ordering/`. A read-only dry run has been completed; no product data has been changed. See `scripts/product-ordering/README.md` for usage and the actual safeguards.
Store: `abode-furnishings-co.myshopify.com`.

## Theme rules on dev

| Product tags                      | Storefront behavior                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Neither `instock` nor `clearance` | Order-only badge on product cards; inquiry form instead of Add to cart.                                |
| `instock`                         | Normal purchase form; In stock badge while available, Sold out when unavailable.                       |
| `clearance`                       | Normal purchase form; Clearance badge, plus Sold out when unavailable.                                 |
| Both `instock` and `clearance`    | Normal purchase form; In stock and Clearance while available; Sold out and Clearance when unavailable. |
| `contact`, with any of the above  | No effect.                                                                                             |

The same purchase rule applies to product-card quick-buy buttons and the shared product form used by quick shop. An unavailable option remains disabled even if another option can be purchased.

“Available” means Shopify permits a purchase. It does not necessarily mean a positive physical stock count. After enabling continue-selling, an `instock` product at zero quantity can still show In stock and accept orders. Keep `instock` accurate if the label is intended to promise stock on hand. Order-only products remain inquiries in this theme even when Shopify permits selling their variants.

`noprice` still hides prices independently. Collection membership rules are unchanged.

## Intended product changes

1. For every product without `clearance`, set every variant's inventory policy to `CONTINUE` (continue selling when out of stock).
2. Remove only the `contact` tag from every product that has it, including clearance products.

“All products” includes active, draft, and archived products. Leave clearance inventory policies unchanged. Do not change quantities, tracking, prices, other tags, publication status, descriptions, or collection rules.

These are store-wide product settings, shared by live themes and other sales channels. Theme forms are not a checkout restriction for direct cart links, apps, or other channels.

## Deployment order

1. Review the theme behavior and deploy these tag rules to the live theme before applying product changes. The existing live theme uses `contact`, so removing it first could expose purchase buttons on order-only products.
2. Check apps, automated collections, Shopify Flow workflows, and integrations for dependencies on `contact`. Resolve any dependencies before removal.
3. Run the script's read-only plan mode against fresh store data, review its report, then apply that exact saved plan during a short product-editing pause.
4. Verify the product data and storefront after the run. Update the client handover guide to describe the new rules.

Do not use the earlier catalog export as the migration input: at least Scarlett's tags have changed since that export.

## Script design

Use Node under the project's normal NVM runtime and Shopify CLI Connector authentication. Pin Admin API version `2026-10`, validate operations against that version when implementing, and keep credentials out of the repository and logs. Read-only planning needs `read_products` and, for the inventory-tracking audit, `read_inventory`; applying product changes needs `write_products`.

Provide four explicit modes: `plan`, `apply`, `verify`, and `rollback`. Default to `plan`; never mutate as an import side effect or fallback. Apply requires a saved plan, its checksum, and the exact expected shop ID/domain.

### Plan: export and review

- Confirm the shop ID/domain before any work. Fetch all products and all variants with complete pagination, including more than 250 variants on a product. Fail on missing pages, API errors, or inconsistent totals.
- Save a dated JSON backup containing product IDs, handles, status, tags, update timestamps, and variant IDs, current inventory policies, quantities, availability, and tracking state. Keep this out of Git.
- Produce a JSON change manifest and readable CSV summary. Record old and intended values; skip variants already set to CONTINUE and products without `contact`.
- Report affected products and variants by status, remaining clearance products, and products whose storefront behavior changes under the new tag rule.
- Flag clearance variants already set to CONTINUE or not inventory-tracked: they may remain purchasable at zero quantity. Do not silently change them to DENY or enable tracking.
- Flag zero-stock `instock` products, `contact` combined with `instock` or `clearance`, and purchasable products with `noprice` for review.

### Apply: bounded and restartable

- Re-read tags, variant membership, and inventory policies immediately before each product. Skip and report conflicts if classification or planned fields changed. A newly added `clearance` tag must prevent the CONTINUE update.
- Use `productVariantsBulkUpdate` per product, with only variant IDs and `inventoryPolicy: CONTINUE`, at most 250 inputs per call, and `allowPartialUpdates: false`.
- Use `tagsRemove` with only `contact`. Never replace the whole tag list. For non-clearance products, remove the tag after their planned inventory changes succeed; clearance products receive only the tag removal.
- Process sequentially or with tightly bounded concurrency. Respect Shopify's reported query budget and retry delays; use capped backoff for throttling and transient failures. Stop on authentication, permissions, or repeated failures.
- Check GraphQL errors and mutation `userErrors` even when HTTP succeeds. Persist a journal entry before each request and the verified result afterward.
- If a request times out, read current values before retrying. Resume by checking actual state, not by assuming pending requests failed. Report partial progress; there is no catalog-wide transaction.
- A product-editing pause is necessary because these mutations do not provide an atomic conditional update for product tags. Rechecking reduces conflicts but cannot eliminate the small race between a read and write.

### Verify and rollback

- Independently fetch all products and variants again. Confirm every non-clearance variant is CONTINUE, no product has `contact`, and clearance policies and all other tags match the backup, allowing only explicitly reviewed concurrent changes.
- Report missing, newly created, or changed products/variants as exceptions instead of silently adding them to an approved plan.
- Check representative product pages, collection/search cards, and quick shop: order-only with and without the former contact tag; in-stock; available clearance; unavailable clearance; mixed-availability variants.
- Rollback restores only fields successfully changed by this run: each variant's original inventory policy and `contact` only on products from which this run removed it. Use `tagsAdd`, preserving all other tags.
- Before rollback, compare current values and journal snapshots. Skip/report conflicts and unknown request outcomes until reconciled. Restore product data before reverting to a theme that depends on `contact`.

## Ongoing maintenance

This is a one-time cleanup. New non-clearance products and variants must also be configured to continue selling. If a product is later moved into Clearance, review its inventory policy: adding the tag alone will not switch CONTINUE back to DENY. Decide whether to automate these ongoing checks separately.

## References

- [Shopify product availability](https://shopify.dev/docs/api/liquid/objects/product#product-available)
- [Variant inventory policy](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/ProductVariantInventoryPolicy)
- [Update variants in batches](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productVariantsBulkUpdate)
- [Remove specific tags](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsRemove)
- [Restore specific tags](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd)
