import type { Repositories, RepositoryUnitOfWork } from "../repositories/repository-types";
import type { ToolExecutor } from "../agent/tool-executor";
import { ClearDataSchema, ExportBundleSchema } from "./service-contracts";
export class DataService {
  constructor(private readonly r: Repositories & RepositoryUnitOfWork, private readonly tools: ToolExecutor, private readonly now: () => Date) {}
  export(owner: string) { return this.r.withTransaction(tx => ExportBundleSchema.parse({ schemaVersion: 2, exportedAt: this.now().toISOString(), ...tx.support.exportOwnerData(owner) })); }
  clear(ownerId: string, raw: unknown) {
    const { operationId, confirmationPhrase, expectedSettingId } = ClearDataSchema.parse(raw);
    return this.tools.execute({ toolName: "clear_all_data", args: { confirmation: confirmationPhrase, expectedSettingId }, context: { ownerId, operationId, source: "ui_confirmation" } });
  }
}
