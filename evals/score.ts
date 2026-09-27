import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EvaluationResultSchema, HumanReviewsSchema, type EvaluationResult, type HumanReview } from "./schema";

const dimensions = ["goalAccuracy", "actionability", "timeRealism", "verifiability", "constraintRespect"] as const;
const ScoreArgsSchema = z.object({ results: z.string().trim().min(1), reviews: z.string().trim().min(1) }).strict();

export function scoreArtifacts(results: EvaluationResult[], rawReviews: unknown) {
  const reviews = HumanReviewsSchema.parse(rawReviews);
  const scoreable = results.filter(result => result.message !== null || result.draft !== null);
  const resultIds = new Set(scoreable.map(result => result.caseId));
  const reviewIds = new Set(reviews.map(review => review.caseId));
  if (resultIds.size !== scoreable.length || resultIds.size !== reviewIds.size || [...resultIds].some(id => !reviewIds.has(id)) || [...reviewIds].some(id => !resultIds.has(id)))
    throw new Error("Reviewer cases must match produced evaluation artifacts exactly");
  const means = Object.fromEntries(dimensions.map(dimension => [dimension,
    reviews.reduce((sum, review) => sum + review[dimension], 0) / reviews.length,
  ])) as Record<(typeof dimensions)[number], number>;
  const overallMean = dimensions.reduce((sum, dimension) => sum + means[dimension], 0) / dimensions.length;
  const safetyPassed = results.every(result => result.machinePassed);
  return {
    reviewedCases: reviews.length,
    means,
    overallMean,
    safetyPassed,
    accepted: safetyPassed && overallMean >= 4,
  };
}

function parseArgs(argv: string[]) {
  const entries: Record<string, string> = {};
  for (const argument of argv) {
    const match = /^--(results|reviews)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown score argument: ${argument}`);
    entries[match[1]] = match[2];
  }
  return ScoreArgsSchema.parse(entries);
}

export function loadAndScore(resultsDirectory: string, reviewsFile: string) {
  const results = readdirSync(resultsDirectory)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => EvaluationResultSchema.parse(JSON.parse(readFileSync(resolve(resultsDirectory, name), "utf8"))));
  const reviews: HumanReview[] = HumanReviewsSchema.parse(JSON.parse(readFileSync(reviewsFile, "utf8")));
  return scoreArtifacts(results, reviews);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = loadAndScore(resolve(options.results), resolve(options.reviews));
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.accepted) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation scoring failed");
    process.exitCode = 1;
  }
}
