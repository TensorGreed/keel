import ts from "typescript";
import { feature } from "@app/feature";

export function main(): string {
  return `${feature()} (ts ${ts.version})`;
}
