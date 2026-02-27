import { SupabaseAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import {
  ResourceErrors,
  ServerErrors,
} from "@/app/api/v1/osograph/utils/errors";
import type { MutationResolvers } from "@/app/api/v1/osograph/types/generated/types";
import { createResolversCollection } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgResourceClient } from "@/app/api/v1/osograph/utils/resolver-middleware";
import { getTrinoAdminClient } from "@/lib/clients/trino";
import { deleteTrinoCatalog } from "@/lib/dynamic-connectors";
import type { DynamicConnectorsRow } from "@/lib/types/schema-types";
import { createQueueService } from "@/lib/services/queue";
import { SyncConnectionRunRequest } from "@opensource-observer/osoprotobufs/sync-connection";

async function syncDataConnection(
  supabase: SupabaseAdminClient,
  userId: string,
  dataConnection: Pick<DynamicConnectorsRow, "id" | "org_id">,
) {
  const { data: queuedRun, error: queuedRunError } = await supabase
    .from("run")
    .insert({
      org_id: dataConnection.org_id,
      run_type: "manual",
      requested_by: userId,
      metadata: {
        dataConnectionId: dataConnection.id,
      },
    })
    .select()
    .single();
  if (queuedRunError || !queuedRun) {
    logger.error(
      `Error creating run for data connection ${dataConnection.id}: ${queuedRunError?.message}`,
    );
    throw ServerErrors.database("Failed to create run request");
  }

  const queueService = createQueueService();

  const runIdBuffer = Buffer.from(queuedRun.id.replace(/-/g, ""), "hex");
  const publishMessage: SyncConnectionRunRequest = {
    runId: new Uint8Array(runIdBuffer),
    connectionId: dataConnection.id,
  };

  const result = await queueService.queueMessage({
    queueName: "sync_connection_run_requests",
    message: publishMessage,
    encoder: SyncConnectionRunRequest,
  });
  if (!result.success) {
    logger.error(
      `Failed to publish message to queue: ${result.error?.message}`,
    );
    throw ServerErrors.queueError(
      result.error?.message || "Failed to publish to queue",
    );
  }
  return queuedRun;
}

type DataConnectionMutationResolvers = Pick<
  Required<MutationResolvers>,
  "deleteDataConnection" | "syncDataConnection"
>;

export const dataConnectionMutations =
  createResolversCollection<DataConnectionMutationResolvers>()
    .defineWithBuilder("deleteDataConnection", (builder) =>
      builder
        .use(
          withOrgResourceClient(
            "data_connection",
            ({ args }) => args.id,
            "admin",
          ),
        )
        .resolve(async (_, { id }, context) => {
          const { data: connector, error: updateError } = await context.client
            .from("dynamic_connectors")
            .update({
              deleted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select()
            .single();

          if (updateError || !connector) {
            logger.error("Failed to delete data connection:", updateError);
            throw ServerErrors.database(
              `Failed to delete data connection: ${updateError.message}`,
            );
          }

          const trinoClient = getTrinoAdminClient();
          const { error: trinoError } = await deleteTrinoCatalog(
            trinoClient,
            connector,
          );

          if (trinoError) {
            // Best effort reverting operation
            await context.client
              .from("dynamic_connectors")
              .update({ deleted_at: null })
              .eq("id", id);
            throw ServerErrors.externalService(
              `Error dropping catalog: ${trinoError}`,
            );
          }

          return {
            success: true,
            message: "Data connection deleted successfully",
          };
        }),
    )
    .defineWithBuilder("syncDataConnection", (builder) =>
      builder
        .use(
          withOrgResourceClient(
            "data_connection",
            ({ args }) => args.id,
            "write",
          ),
        )
        .resolve(async (_, { id }, context) => {
          const { data: dataConnection, error: fetchError } =
            await context.client
              .from("dynamic_connectors")
              .select("id, org_id")
              .eq("id", id)
              .single();

          if (fetchError || !dataConnection) {
            throw ResourceErrors.notFound("DataConnection", id);
          }

          if (!context.authenticatedUser) {
            throw ServerErrors.internal(
              "authenticatedUser required for syncDataConnection",
            );
          }
          const queuedRun = await syncDataConnection(
            context.client,
            context.authenticatedUser.userId,
            dataConnection,
          );

          return {
            success: true,
            run: queuedRun,
            message: "Data connection sync run queued successfully",
          };
        }),
    )
    .resolvers();
