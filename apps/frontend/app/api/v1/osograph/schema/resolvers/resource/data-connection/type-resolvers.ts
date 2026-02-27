import {
  type DataConnectionResolvers,
  type DataConnectionAliasResolvers,
  type Resolvers,
} from "@/app/api/v1/osograph/types/generated/types";
import { DataConnectionTypeSchema } from "@/app/api/v1/osograph/types/generated/validation";
import { ServerErrors } from "@/app/api/v1/osograph/utils/errors";
import { createResolver } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgResourceClient } from "@/app/api/v1/osograph/utils/resolver-middleware";
import { getOrganization } from "@/app/api/v1/osograph/utils/auth";
import type { FilterableConnectionArgs } from "@/app/api/v1/osograph/utils/pagination";
import {
  getMaterializations,
  getModelContext,
} from "@/app/api/v1/osograph/utils/resolver-helpers";
import {
  executePreviewQuery,
  generateTableId,
} from "@/app/api/v1/osograph/utils/model";

export const dataConnectionTypeResolvers: Pick<
  Resolvers,
  "DataConnection" | "DataConnectionAlias"
> = {
  DataConnection: {
    orgId: (parent) => parent.org_id,
    createdAt: (parent) => parent.created_at,
    updatedAt: (parent) => parent.updated_at,
    name: (parent) => parent.connector_name,
    type: (parent) =>
      DataConnectionTypeSchema.parse(parent.connector_type.toUpperCase()),
    organization: createResolver<DataConnectionResolvers, "organization">()
      .use(
        withOrgResourceClient(
          "data_connection",
          ({ parent }) => parent.id,
          "read",
        ),
      )
      .resolve(async (parent, _args, context) =>
        getOrganization(parent.org_id, context.client),
      ),
  },

  DataConnectionAlias: {
    orgId: (parent) => parent.org_id,
    datasetId: (parent) => parent.dataset_id,
    dataConnectionId: (parent) => parent.data_connection_id,
    schema: (parent) => parent.schema_name,
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
        generateTableId("DATA_CONNECTION", tableName),
      );
    },
    modelContext: createResolver<DataConnectionAliasResolvers, "modelContext">()
      .use(
        withOrgResourceClient(
          "data_connection",
          ({ parent }) => parent.data_connection_id,
        ),
      )
      .resolve(async (parent, args, context) =>
        getModelContext(parent.dataset_id, args.tableName, context.client),
      ),
    previewData: createResolver<DataConnectionAliasResolvers, "previewData">()
      .use(
        withOrgResourceClient(
          "data_connection",
          ({ parent }) => parent.data_connection_id,
          "read",
        ),
      )
      .resolve(async (parent, args, context) => {
        const tableId = generateTableId("DATA_CONNECTION", args.tableName);
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
