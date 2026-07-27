import { NAME } from "./config.js";
export function connect(): string {
  return `db:${NAME}`;
}
