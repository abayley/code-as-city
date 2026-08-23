// Local showcases: the deterministic prototype's generated maps, loaded
// alongside the upstream curated ones so no file picker is needed.
import type { CityMap } from "./city-map";
import { showcases as upstreamShowcases, type Showcase } from "./showcase-maps";
import ariaEvalsMap from "../../out/aria-evals/map.json";
import ariaEvalsOverviewMap from "../../out/aria-evals-overview/map.json";
import functionaryMap from "../../out/functionary.dev/map.json";
import nzlawOverviewMap from "../../out/nzlaw-overview/map.json";
import nzlawMap from "../../out/nzlaw/map.json";
import ariaToolsMap from "../../out/aria-tools/map.json";
import ariaToolsOverviewMap from "../../out/aria-tools-overview/map.json";

const localShowcases: Showcase[] = [
  { slug: "aria-evals", map: ariaEvalsMap as unknown as CityMap, language: "TypeScript", shape: "Deterministic draft", accent: "#376f71" },
  { slug: "aria-evals-overview", map: ariaEvalsOverviewMap as unknown as CityMap, language: "TypeScript", shape: "Module overview", accent: "#8f7da8" },
  { slug: "nzlaw-overview", map: nzlawOverviewMap as unknown as CityMap, language: "TypeScript", shape: "Module overview", accent: "#75967b" },
  { slug: "nzlaw", map: nzlawMap as unknown as CityMap, language: "TypeScript", shape: "Deterministic draft", accent: "#b77f8b" },
  { slug: "aria-tools", map: ariaToolsMap as unknown as CityMap, language: "TypeScript", shape: "Deterministic draft", accent: "#718eaf" },
  { slug: "aria-tools-overview", map: ariaToolsOverviewMap as unknown as CityMap, language: "TypeScript", shape: "Module overview", accent: "#6d9da5" },
  { slug: "functionary-dev", map: functionaryMap as unknown as CityMap, language: "TypeScript", shape: "Deterministic draft", accent: "#8a6fae" },
];

export const showcases: Showcase[] = [...localShowcases, ...upstreamShowcases];
export const defaultShowcase = showcases[0];
export type { Showcase };
