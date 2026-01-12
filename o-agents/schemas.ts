import { z } from "zod";

export const reviewCommentSchema = z.array(
  z.object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    body: z.string().min(1),
  }),
);
export const reviewResponseSchema = z.array(z.string().min(1));
