import { z } from "zod";

// =============================================================================
// SCHEMAS
// =============================================================================

export const DoctorValidationSchema = z
  .object({
    effective: z.boolean(),
    coverage_assessment: z.enum(["good", "partial", "poor"]),
    concerns: z
      .array(
        z
          .object({
            issue: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            evidence: z.string(),
          })
          .strict(),
      )
      .default([]),
    recommendations: z
      .array(
        z
          .object({
            description: z.string(),
            impact: z.enum(["high", "medium", "low"]),
            action: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  })
  .strict();

export type DoctorValidationReport = z.infer<typeof DoctorValidationSchema>;

export const DoctorValidatorJsonSchema = {
  type: "object",
  properties: {
    effective: { type: "boolean" },
    coverage_assessment: { type: "string", enum: ["good", "partial", "poor"] },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
        },
        required: ["issue", "severity", "evidence"],
        additionalProperties: false,
      },
      default: [],
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          action: { type: "string" },
        },
        required: ["description", "impact"],
        additionalProperties: false,
      },
      default: [],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["effective", "coverage_assessment", "concerns", "recommendations", "confidence"],
  additionalProperties: false,
} as const;
