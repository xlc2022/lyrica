// The highlighter's grammars, in a chunk of their own that highlight.tsx loads the first time code shows: highlight.js's
// common set, plus Nix and Dockerfile for her machines.
import { common, createLowlight } from "lowlight";
import nix from "highlight.js/lib/languages/nix";
import dockerfile from "highlight.js/lib/languages/dockerfile";

export const lowlight = createLowlight({ ...common, nix, dockerfile });
