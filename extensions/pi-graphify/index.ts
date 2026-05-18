import graphifyExtension from "./graphify";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  graphifyExtension(pi);
}
