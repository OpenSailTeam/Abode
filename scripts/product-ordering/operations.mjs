export const API_VERSION = "2026-10";
export const STORE = "abode-furnishings-co.myshopify.com";
export const SHOP_ID = "gid://shopify/Shop/62885429503";
const productFields = `id title handle status tags updatedAt onlineStoreUrl variantsCount { count precision }`;
const variantFields = `id title sku inventoryPolicy inventoryQuantity availableForSale updatedAt price compareAtPrice inventoryItem { id tracked }`;
export const operations = {
  identity: `query Identity { shop { id name myshopifyDomain } productsCount(limit: null) { count precision } productVariantsCount(limit: null) { count precision } }`,
  products: `query Products($after: String) { products(first: 250, after: $after, sortKey: ID) { nodes { ${productFields} } pageInfo { hasNextPage endCursor } } }`,
  variants: `query Variants($after: String) { productVariants(first: 200, after: $after, sortKey: ID) { nodes { ${variantFields} product { id } } pageInfo { hasNextPage endCursor } } }`,
  product: `query Product($id: ID!, $after: String) { product(id: $id) { ${productFields} variants(first: 250, after: $after) { nodes { ${variantFields} } pageInfo { hasNextPage endCursor } } } }`,
  policies: `mutation Policies($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $variants, allowPartialUpdates: false) { productVariants { id inventoryPolicy } userErrors { field message } } }`,
  removeContact: `mutation RemoveContact($id: ID!) { tagsRemove(id: $id, tags: ["contact"]) { node { id } userErrors { field message } } }`,
  restoreContact: `mutation RestoreContact($id: ID!) { tagsAdd(id: $id, tags: ["contact"]) { node { id } userErrors { field message } } }`,
};
export const mutationNames = new Set([
  "policies",
  "removeContact",
  "restoreContact",
]);
