import { createResolver } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgScopedClient } from "@/app/api/v1/osograph/utils/resolver-middleware";
import { getUserProfile } from "@/app/api/v1/osograph/utils/auth";
import {
  RunStatus,
  RunTriggerType,
  RunType,
  type Resolvers,
  type RunResolvers,
} from "@/app/api/v1/osograph/types/generated/types";
import { logger } from "@/lib/logger";
import { ServerErrors } from "@/app/api/v1/osograph/utils/errors";
import { getSignedUrl, parseGcsUrl } from "@/lib/clients/gcs";
import { assertNever } from "@opensource-observer/utils";
import { queryWithPagination } from "@/app/api/v1/osograph/utils/query-helpers";
import { StepWhereSchema } from "@/app/api/v1/osograph/utils/validation";
import type { RunRow } from "@/lib/types/schema-types";

function mapRunStatus(status: RunRow["status"]): RunStatus {
  switch (status) {
    case "running":
      return RunStatus.Running;
    case "completed":
      return RunStatus.Success;
    case "failed":
      return RunStatus.Failed;
    case "canceled":
      return RunStatus.Canceled;
    case "queued":
      return RunStatus.Queued;
    default:
      assertNever(status, `Unknown run status: ${status}`);
  }
}

export const runTypeResolvers: Required<Pick<Resolvers, "Run">> = {
  Run: {
    datasetId: (parent) => parent.dataset_id,
    orgId: (parent) => parent.org_id,
    triggerType: (parent) =>
      parent.run_type === "manual"
        ? RunTriggerType.Manual
        : RunTriggerType.Scheduled,
    runType: (parent) =>
      parent.run_type === "manual" ? RunType.Manual : RunType.Scheduled,
    queuedAt: (parent) => parent.queued_at,
    status: (parent) => mapRunStatus(parent.status),
    startedAt: (parent) => parent.started_at,
    finishedAt: (parent) => parent.completed_at,
    metadata: (parent) => parent.metadata,

    logsUrl: async (parent) => {
      if (!parent.logs_url) return null;
      try {
        const parsed = parseGcsUrl(parent.logs_url);
        if (!parsed) {
          logger.warn(
            `Invalid GCS URL format for run ${parent.id}: ${parent.logs_url}`,
          );
          return parent.logs_url;
        }
        return await getSignedUrl(parsed.bucketName, parsed.fileName, 5);
      } catch (error) {
        logger.error(
          `Failed to generate signed URL for run ${parent.id}: ${error}`,
        );
        return parent.logs_url;
      }
    },

    dataset: createResolver<RunResolvers, "dataset">()
      .use(withOrgScopedClient(({ parent }) => parent.org_id))
      .resolve(async (parent, _args, context) => {
        if (!parent.dataset_id) return null;
        const { data, error } = await context.client
          .from("datasets")
          .select("*")
          .eq("id", parent.dataset_id)
          .single();
        if (error) {
          logger.error(
            `Error fetching dataset with id ${parent.dataset_id}: ${error.message}`,
          );
          throw ServerErrors.database(
            `Failed to fetch dataset with id ${parent.dataset_id}`,
          );
        }
        return data;
      }),

    organization: createResolver<RunResolvers, "organization">()
      .use(withOrgScopedClient(({ parent }) => parent.org_id))
      .resolve(async (parent, _args, context) => {
        const { data, error } = await context.client
          .from("organizations")
          .select("*")
          .eq("id", parent.org_id)
          .single();
        if (error) {
          logger.error(
            `Error fetching organization with id ${parent.org_id}: ${error.message}`,
          );
          throw ServerErrors.database(
            `Failed to fetch organization with id ${parent.org_id}`,
          );
        }
        return data;
      }),

    steps: createResolver<RunResolvers, "steps">()
      .use(withOrgScopedClient(({ parent }) => parent.org_id))
      .resolve(async (parent, args, context) => {
        return queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "step",
          whereSchema: StepWhereSchema,
          basePredicate: {
            eq: [{ key: "run_id", value: parent.id }],
          },
        });
      }),

    requestedBy: createResolver<RunResolvers, "requestedBy">()
      .use(withOrgScopedClient(({ parent }) => parent.org_id))
      .resolve(async (parent, _args, context) => {
        if (!parent.requested_by) return null;
        return getUserProfile(parent.requested_by, context.client);
      }),
  },
};
