// The catalog snapshot moved to @kisantractor/database so restore verification can use it outside
// tests; this module keeps the test-utils import path working.
export {
  additivityFindings,
  captureSchemaSnapshot,
  columnsByTable,
  comparableSchema,
  findingKey,
  tableChecksums,
} from "@kisantractor/database";
export type { AdditivityFinding, ColumnShape, SchemaSnapshot, TableChecksum } from "@kisantractor/database";
