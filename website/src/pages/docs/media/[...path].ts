/** The images the published docs use, served from docs/ itself, so there is no second copy. */
import { readFileSync } from "node:fs";
import type { APIRoute } from "astro";
import { docs, mediaType } from "../../../lib/docs";

export function getStaticPaths() {
  return [...docs().media.keys()].map((path) => ({ params: { path } }));
}

export const GET: APIRoute = ({ params }) => {
  const file = docs().media.get(params.path ?? "");
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(file), { headers: { "Content-Type": mediaType(file) } });
};
