import { helper } from "@myorg/shared/src/helpers";
import { label } from "./main.js";

export function run(): string {
  return `${label} ${helper()}`;
}
