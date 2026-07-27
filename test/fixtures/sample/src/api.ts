import { connect } from "./db.js";
export function handler(): string {
  return connect();
}
