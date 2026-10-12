import * as z from "zod";

const PasswordSchema = z
  .string()
  .min(8, "Be at least 8 characters long.")
  .regex(/[a-zA-Z]/, "Contain at least one letter.")
  .regex(/[0-9]/, "Contain at least one number.");

export const SignupFormSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters long.").trim(),
  email: z.email("Please enter a valid email.").trim(),
  password: PasswordSchema,
});

export const ResetPasswordFormSchema = z
  .object({
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const LoginFormSchema = z.object({
  email: z.email("Please enter a valid email.").trim(),
  password: z.string().min(1, "Password is required."),
});

export const S3ConnectionSchema = z.object({
  name: z.string().min(2, "Give this connection a name.").trim(),
  accessKeyId: z.string().min(1, "Access key is required."),
  secretAccessKey: z.string().min(1, "Secret key is required."),
  region: z.string().min(1, "Region is required.").trim(),
  bucket: z.string().min(1, "Bucket is required.").trim(),
  endpoint: z.url("Enter a valid endpoint URL.").optional().or(z.literal("")),
});

export const TicketRefSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  htmlUrl: z.string().min(1),
});

export const BuildFormSchema = z.object({
  applicationId: z.string().min(1),
  version: z.string().min(1, "Version is required.").trim(),
  number: z.string().min(1, "Build number is required.").trim(),
  feature: z.string().min(1, "Feature or work reference is required.").trim(),
  tickets: z.array(TicketRefSchema).optional(),
  releaseNotes: z.string().trim().optional(),
  storageConnectionId: z.string().min(1, "No storage connected for this application."),
  storageObjectKey: z.string().min(1),
  apkFileName: z.string().min(1),
  apkSizeBytes: z.coerce.number().int().positive(),
  // z.coerce.boolean() would turn the string "false" into true.
  hasInspector: z.stringbool().optional().default(false),
  environment: z.enum(["PRODUCTION", "STAGING"]),
});

export type FormState =
  | {
      errors?: Record<string, string[]>;
      message?: string;
    }
  | undefined;

export const ApplicationSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters.").trim(),
  slug: z
    .string()
    .min(2, "Slug must be at least 2 characters.")
    .regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers and hyphens only.")
    .trim(),
  platform: z.string().min(1, "Platform is required.").trim(),
  initials: z
    .string()
    .min(1, "Initials required.")
    .max(4, "Max 4 characters.")
    .trim(),
});

export const ReplaceApkSchema = z.object({
  buildId: z.string().min(1),
  note: z.string().trim().max(2000, "Keep the note under 2000 characters.").optional(),
  storageConnectionId: z.string().min(1, "No storage connected for this application."),
  storageObjectKey: z.string().min(1),
  apkFileName: z.string().min(1),
  apkSizeBytes: z.coerce.number().int().positive(),
  hasInspector: z.stringbool().optional().default(false),
});
