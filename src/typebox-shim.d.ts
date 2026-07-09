// Ambient declaration: pi's jiti loader provides "typebox" at runtime.
// For type-checking, map to the installed @sinclair/typebox.
declare module "typebox" {
	export * from "@sinclair/typebox";
}
