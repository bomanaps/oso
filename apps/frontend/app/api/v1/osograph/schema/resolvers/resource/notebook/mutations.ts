import {
  NotebookErrors,
  ServerErrors,
} from "@/app/api/v1/osograph/utils/errors";
import { putBase64Image } from "@/lib/clients/cloudflare-r2";
import { logger } from "@/lib/logger";
import { validateBase64PngImage } from "@/app/api/v1/osograph/utils/validation";
import { signOsoJwt } from "@/lib/auth/auth";
import { createQueueService } from "@/lib/services/queue/factory";
import { PublishNotebookRunRequest } from "@opensource-observer/osoprotobufs/publish-notebook";
import { revalidateTag } from "next/cache";
import type { MutationResolvers } from "@/app/api/v1/osograph/types/generated/types";
import { createResolversCollection } from "@/app/api/v1/osograph/utils/resolver-builder";
import {
  withOrgResourceClient,
  withValidation,
} from "@/app/api/v1/osograph/utils/resolver-middleware";
import {
  UpdateNotebookInputSchema,
  SaveNotebookPreviewInputSchema,
} from "@/app/api/v1/osograph/types/generated/validation";

const PREVIEWS_BUCKET = "notebook-previews";

type NotebookMutationResolvers = Pick<
  Required<MutationResolvers>,
  | "updateNotebook"
  | "saveNotebookPreview"
  | "publishNotebook"
  | "unpublishNotebook"
>;

export const notebookMutations =
  createResolversCollection<NotebookMutationResolvers>()
    .defineWithBuilder("updateNotebook", (builder) =>
      builder
        .use(withValidation(UpdateNotebookInputSchema()))
        .use(
          withOrgResourceClient(
            "notebook",
            ({ args }) => args.input.id,
            "write",
          ),
        )
        .resolve(async (_, { input }, context) => {
          const updateData: { notebook_name?: string; description?: string } =
            {};
          if (input.name != null) {
            updateData.notebook_name = input.name;
          }
          if (input.description != null) {
            updateData.description = input.description;
          }

          const { data: updated, error } = await context.client
            .from("notebooks")
            .update(updateData)
            .eq("id", input.id)
            .select()
            .single();

          if (error) {
            throw ServerErrors.database(
              `Failed to update notebook: ${error.message}`,
            );
          }

          return {
            notebook: updated,
            message: "Notebook updated successfully",
            success: true,
          };
        }),
    )
    .defineWithBuilder("saveNotebookPreview", (builder) =>
      builder
        .use(withValidation(SaveNotebookPreviewInputSchema()))
        .use(
          withOrgResourceClient(
            "notebook",
            ({ args }) => args.input.notebookId,
            "write",
          ),
        )
        .resolve(async (_, { input }) => {
          validateBase64PngImage(input.preview);

          try {
            logger.log(
              `Uploading notebook preview for ${input.notebookId} to bucket "${PREVIEWS_BUCKET}"`,
            );

            await putBase64Image(
              PREVIEWS_BUCKET,
              `${input.notebookId}.png`,
              input.preview,
            );

            logger.log(
              `Successfully saved notebook preview for ${input.notebookId}`,
            );

            return {
              success: true,
              message: "Notebook preview saved successfully",
            };
          } catch (error) {
            logger.error(
              `Failed to save notebook preview for ${input.notebookId}: ${error}`,
            );
            throw ServerErrors.storage("Failed to save notebook preview");
          }
        }),
    )
    .defineWithBuilder("publishNotebook", (builder) =>
      builder
        .use(
          withOrgResourceClient(
            "notebook",
            ({ args }) => args.notebookId,
            "admin",
          ),
        )
        .resolve(async (_, { notebookId }, context) => {
          const { data: notebook } = await context.client
            .from("notebooks")
            .select("id, organizations!inner(id, org_name)")
            .eq("id", notebookId)
            .single();

          if (!notebook) {
            throw NotebookErrors.notFound();
          }

          if (!context.authenticatedUser) {
            throw ServerErrors.internal(
              "authenticatedUser required to run notebook",
            );
          }
          const osoToken = await signOsoJwt(context.authenticatedUser, {
            orgId: notebook.organizations.id,
            orgName: notebook.organizations.org_name,
          });

          const { data: queuedRun, error: queuedRunError } =
            await context.client
              .from("run")
              .insert({
                org_id: notebook.organizations.id,
                run_type: "manual",
                requested_by: context.authenticatedUser.userId,
                metadata: {
                  notebookId: notebook.id,
                },
              })
              .select()
              .single();
          if (queuedRunError || !queuedRun) {
            logger.error(
              `Error creating run for notebook ${notebook.id}: ${queuedRunError?.message}`,
            );
            throw ServerErrors.database("Failed to create run request");
          }

          const queueService = createQueueService();

          const runIdBuffer = Buffer.from(
            queuedRun.id.replace(/-/g, ""),
            "hex",
          );
          const publishMessage: PublishNotebookRunRequest = {
            runId: new Uint8Array(runIdBuffer),
            notebookId: notebook.id,
            osoApiKey: osoToken,
          };

          const result = await queueService.queueMessage({
            queueName: "publish_notebook_run_requests",
            message: publishMessage,
            encoder: PublishNotebookRunRequest,
          });
          if (!result.success) {
            logger.error(
              `Failed to publish message to queue: ${result.error?.message}`,
            );
            throw ServerErrors.queueError(
              result.error?.message || "Failed to publish to queue",
            );
          }

          return {
            success: true,
            run: queuedRun,
            message: "Notebook publish run queued successfully",
          };
        }),
    )
    .defineWithBuilder("unpublishNotebook", (builder) =>
      builder
        .use(
          withOrgResourceClient(
            "notebook",
            ({ args }) => args.notebookId,
            "admin",
          ),
        )
        .resolve(async (_, { notebookId }, context) => {
          const { data: publishedNotebook, error } = await context.client
            .from("published_notebooks")
            .select("*")
            .eq("notebook_id", notebookId)
            .single();
          if (error) {
            logger.log("Failed to find published notebook:", error);
            throw NotebookErrors.notFound();
          }
          const { error: deleteError } = await context.client.storage
            .from("published-notebooks")
            .remove([publishedNotebook.data_path]);
          if (deleteError) {
            logger.log("Failed to delete notebook file:", deleteError);
            throw ServerErrors.database("Failed to delete notebook file");
          }
          const { error: updateError } = await context.client
            .from("published_notebooks")
            .update({
              deleted_at: new Date().toISOString(),
              updated_by: context.authenticatedUser?.userId,
            })
            .eq("id", publishedNotebook.id);
          if (updateError) {
            logger.log("Failed to delete notebook file:", updateError);
            throw ServerErrors.database("Failed to delete notebook file");
          }

          revalidateTag(publishedNotebook.id);
          return {
            success: true,
            message: "Notebook unpublished successfully",
          };
        }),
    )
    .resolvers();
