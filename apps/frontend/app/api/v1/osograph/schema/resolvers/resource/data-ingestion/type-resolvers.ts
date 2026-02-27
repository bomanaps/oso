import {
  getMaterializations,
  getModelContext,
} from "@/app/api/v1/osograph/utils/resolver-helpers";
import type { FilterableConnectionArgs } from "@/app/api/v1/osograph/utils/pagination";
import {
  executePreviewQuery,
  generateTableId,
} from "@/app/api/v1/osograph/utils/model";
import type {
  DataIngestionResolvers,
  Resolvers,
} from "@/app/api/v1/osograph/types/generated/types";
import { DataIngestionFactoryTypeSchema } from "@/app/api/v1/osograph/types/generated/validation";
import { ServerErrors } from "@/app/api/v1/osograph/utils/errors";
import { createResolver } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgResourceClient } from "@/app/api/v1/osograph/utils/resolver-middleware";

export const dataIngestionTypeResolvers: Pick<Resolvers, "DataIngestion"> = {
  DataIngestion: {
    id: (parent) => parent.id,
    orgId: (parent) => parent.org_id,
    datasetId: (parent) => parent.dataset_id,
    factoryType: (parent) =>
      DataIngestionFactoryTypeSchema.parse(parent.factory_type),
    config: (parent) => parent.config,
    createdAt: (parent) => parent.created_at,
    updatedAt: (parent) => parent.updated_at,
    modelContext: createResolver<DataIngestionResolvers, "modelContext">()
      .use(withOrgResourceClient("data_ingestion", ({ parent }) => parent.id))
      .resolve(async (parent, args, context) =>
        getModelContext(parent.dataset_id, args.tableName, context.client),
      ),
    materializations: async (
      parent,
      args: FilterableConnectionArgs & { tableName: string },
      context,
    ) => {
      const { tableName, ...restArgs } = args;
      return getMaterializations(
        restArgs,
        context,
        parent.org_id,
        parent.dataset_id,
        generateTableId("DATA_INGESTION", tableName),
      );
    },
    previewData: createResolver<DataIngestionResolvers, "previewData">()
      .use(
        withOrgResourceClient(
          "data_ingestion",
          ({ parent }) => parent.id,
          "read",
        ),
      )
      .resolve(async (parent, args, context) => {
        const tableId = generateTableId("DATA_INGESTION", args.tableName);

        if (!context.authenticatedUser) {
          throw ServerErrors.internal(
            "authenticatedUser required for previewData",
          );
        }
        return executePreviewQuery(
          parent.org_id,
          parent.dataset_id,
          tableId,
          context.authenticatedUser,
          args.tableName,
          context.client,
        );
      }),
  },
};
