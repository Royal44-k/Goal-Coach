import { z } from "zod";
import { GoalInputSchema } from "@/core/domain/contracts";
import { ContractAssumptionSchema } from "@/lib/public-api-schemas";

const input = z.object({ contract: GoalInputSchema, assumptions: z.array(ContractAssumptionSchema) }).passthrough();
export type AssumptionViolation = { field: z.infer<typeof ContractAssumptionSchema>["field"]; rule: "duplicate_assumption_field" | "null_contract_field" };

/** Finite, allowlisted field names and rule codes only; never carries reason or contract values. */
export function knownAssumptionViolations(raw: unknown): AssumptionViolation[] {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return [];
  const { contract, assumptions } = parsed.data;
  return ContractAssumptionSchema.shape.field.options.flatMap(field => {
    const count = assumptions.filter(item => item.field === field).length;
    return [
      ...(count > 1 ? [{ field, rule: "duplicate_assumption_field" as const }] : []),
      ...(count > 0 && contract[field] === null ? [{ field, rule: "null_contract_field" as const }] : []),
    ];
  });
}
