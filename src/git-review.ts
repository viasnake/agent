import { z } from "zod";

export const gitReviewPath = z.string().min(1).max(240);
const commit = z.string().regex(/^[0-9a-f]{40}$/i);
export const gitRepositoryQuery = z.object({ repo: gitReviewPath }).strict();
export const gitChangesQuery = gitRepositoryQuery.extend({
  base: commit.optional(),
});
export const gitReviewHistoryLimit = 50;
export const gitPatchQuery = gitChangesQuery
  .extend({
    path: gitReviewPath,
    head: commit,
    untracked: z.literal("1").optional(),
  })
  .strict();
export const gitReviewRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repositories") }).strict(),
  gitRepositoryQuery.extend({ kind: z.literal("history") }),
  gitChangesQuery.extend({ kind: z.literal("changes") }),
  gitPatchQuery.extend({ kind: z.literal("patch") }),
]);
export type GitReviewRequest = z.infer<typeof gitReviewRequest>;
const patchLimit = 256 * 1024;
export const gitReviewResult = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repositories"),
      repositories: z.array(gitReviewPath).max(30),
      limited: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("history"),
      commits: z
        .array(
          z
            .object({
              oid: commit,
              date: z.string().max(32),
              subject: z.string().max(400),
            })
            .strict(),
        )
        .max(gitReviewHistoryLimit),
      limited: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("changes"),
      head: commit,
      files: z
        .array(
          z
            .object({
              path: gitReviewPath,
              status: z.enum(["A", "D", "M", "T", "U", "?"]),
            })
            .strict(),
        )
        .max(200),
      limited: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal("patch"), text: z.string().max(patchLimit) })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "repository",
        "commit",
        "changed",
        "binary",
        "limit",
        "file",
      ]),
    })
    .strict(),
]);
export type GitReviewResult = z.infer<typeof gitReviewResult>;
export const gitReviewPatchBytes = patchLimit;
