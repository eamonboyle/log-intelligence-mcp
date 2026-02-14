import { ILogAdapter } from "./base.js";
import { SerilogAdapter } from "./serilog.js";
import { ElasticAdapter } from "./elastic.js";
import { SqlAdapter } from "./sql.js";
import { FlatfileAdapter } from "./flatfile.js";
import { AdapterType } from "../types.js";

const adapters: Record<AdapterType, ILogAdapter> = {
  serilog: new SerilogAdapter(),
  elastic: new ElasticAdapter(),
  sql: new SqlAdapter(),
  flatfile: new FlatfileAdapter(),
};

export function getAdapter(type: AdapterType): ILogAdapter {
  const adapter = adapters[type];
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}. Valid types: ${Object.keys(adapters).join(", ")}`);
  }
  return adapter;
}

export { ILogAdapter } from "./base.js";
