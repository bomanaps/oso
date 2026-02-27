import { getOrganization } from "@/app/api/v1/osograph/utils/auth";
import {
  ResourceErrors,
  ServerErrors,
} from "@/app/api/v1/osograph/utils/errors";
import {
  getMaterializations,
  getModelContext,
  getModelRunConnection,
  getResourceById,
} from "@/app/api/v1/osograph/utils/resolver-helpers";
import {
  ConnectionArgs,
  FilterableConnectionArgs,
} from "@/app/api/v1/osograph/utils/pagination";
import {
  DataModelReleaseWhereSchema,
  DataModelRevisionWhereSchema,
} from "@/app/api/v1/osograph/utils/validation";
import { queryWithPagination } from "@/app/api/v1/osograph/utils/query-helpers";
import {
  executePreviewQuery,
  generateTableId,
} from "@/app/api/v1/osograph/utils/model";
import type {
  DataModelResolvers,
  DataModelRevisionResolvers,
  DataModelReleaseResolvers,
  Resolvers,
} from "@/app/api/v1/osograph/types/generated/types";
import { createResolver } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgResourceClient } from "@/app/api/v1/osograph/utils/resolver-middleware";

export const dataModelTypeResolvers: Pick<
  Resolvers,
  "DataModel" | "DataModelRevision" | "DataModelRelease" | "DataModelDependency"
> = {
  DataModel: {
    orgId: (parent) => parent.org_id,
    organization: createResolver<DataModelResolvers, "organization">()
      .use(
        withOrgResourceClient("data_model", ({ parent }) => parent.id, "read"),
      )
      .resolve(async (parent, _args, context) =>
        getOrganization(parent.org_id, context.client),
      ),
    dataset: createResolver<DataModelResolvers, "dataset">()
      .use(
        withOrgResourceClient("data_model", ({ parent }) => parent.id, "read"),
      )
      .resolve(async (parent, _args, context) => {
        const dataset = await getResourceById(
          "datasets",
          parent.dataset_id,
          context.client,
        );
        if (!dataset)
          throw ResourceErrors.notFound("Dataset", parent.dataset_id);
        return dataset;
      }),
    revisions: createResolver<DataModelResolvers, "revisions">()
      .use(
        withOrgResourceClient("data_model", ({ parent }) => parent.id, "read"),
      )
      .resolve(async (parent, args: FilterableConnectionArgs, context) =>
        queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "model_revision",
          whereSchema: DataModelRevisionWhereSchema,
          basePredicate: {
            eq: [{ key: "model_id", value: parent.id }],
          },
        }),
      ),
    releases: createResolver<DataModelResolvers, "releases">()
      .use(
        withOrgResourceClient("data_model", ({ parent }) => parent.id, "read"),
      )
      .resolve(async (parent, args: FilterableConnectionArgs, context) =>
        queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "model_release",
          whereSchema: DataModelReleaseWhereSchema,
          basePredicate: {
            eq: [{ key: "model_id", value: parent.id }],
          },
          orderBy: {
            key: "created_at",
            ascending: false,
          },
        }),
      ),
    isEnabled: (parent) => parent.is_enabled,
    createdAt: (parent) => parent.created_at,
    updatedAt: (parent) => parent.updated_at,
    latestRevision: createResolver<DataModelResolvers, "latestRevision">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) => {
        const { data, error } = await context.client
          .from("model_revision")
          .select("*")
          .eq("model_id", parent.id)
          .order("revision_number", { ascending: false })
          .limit(1)
          .single();

        if (error) {
          return null;
        }
        return data;
      }),
    latestRelease: createResolver<DataModelResolvers, "latestRelease">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) => {
        const { data, error } = await context.client
          .from("model_release")
          .select("*")
          .eq("model_id", parent.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (error) {
          return null;
        }
        return data;
      }),
    runs: createResolver<DataModelResolvers, "runs">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.id))
      .resolve(async (parent, args: ConnectionArgs, context) =>
        getModelRunConnection(
          parent.dataset_id,
          parent.id,
          args,
          context.client,
        ),
      ),
    modelContext: createResolver<DataModelResolvers, "modelContext">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) =>
        getModelContext(parent.dataset_id, parent.id, context.client),
      ),
    materializations: async (parent, args: FilterableConnectionArgs, context) =>
      getMaterializations(
        args,
        context,
        parent.org_id,
        parent.dataset_id,
        generateTableId("USER_MODEL", parent.id),
      ),
    previewData: createResolver<DataModelResolvers, "previewData">()
      .use(
        withOrgResourceClient("data_model", ({ parent }) => parent.id, "read"),
      )
      .resolve(async (parent, _args, context) => {
        const tableId = generateTableId("USER_MODEL", parent.id);

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
          parent.name,
          context.client,
        );
      }),
  },

  DataModelRevision: {
    orgId: (parent) => parent.org_id,
    dataModelId: (parent) => parent.model_id,
    dataModel: createResolver<DataModelRevisionResolvers, "dataModel">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.model_id))
      .resolve(async (parent, _args, context) => {
        const { data, error } = await context.client
          .from("model")
          .select("*")
          .eq("id", parent.model_id)
          .single();
        if (error) {
          throw ResourceErrors.notFound("DataModel", parent.model_id);
        }
        return data;
      }),
    organization: createResolver<DataModelRevisionResolvers, "organization">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.model_id))
      .resolve(async (parent, _args, context) =>
        getOrganization(parent.org_id, context.client),
      ),
    revisionNumber: (parent) => parent.revision_number,
    start: (parent) => parent.start,
    end: (parent) => parent.end,
    dependsOn: (parent) => parent.depends_on,
    partitionedBy: (parent) => parent.partitioned_by,
    clusteredBy: (parent) => parent.clustered_by,
    kindOptions: (parent) => parent.kind_options,
    createdAt: (parent) => parent.created_at,
  },

  DataModelDependency: {
    tableId: (parent) => parent.model_id ?? "",
    alias: (parent) => parent.alias,
  },

  DataModelRelease: {
    orgId: (parent) => parent.org_id,
    dataModelId: (parent) => parent.model_id,
    revisionId: (parent) => parent.model_revision_id,
    dataModel: createResolver<DataModelReleaseResolvers, "dataModel">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.model_id))
      .resolve(async (parent, _args, context) => {
        const { data, error } = await context.client
          .from("model")
          .select("*")
          .eq("id", parent.model_id)
          .single();
        if (error) {
          throw ResourceErrors.notFound("DataModel", parent.model_id);
        }
        return data;
      }),
    revision: createResolver<DataModelReleaseResolvers, "revision">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.model_id))
      .resolve(async (parent, _args, context) => {
        const { data, error } = await context.client
          .from("model_revision")
          .select("*")
          .eq("id", parent.model_revision_id)
          .single();
        if (error) {
          throw ResourceErrors.notFound(
            "DataModelRevision",
            parent.model_revision_id,
          );
        }
        return data;
      }),
    organization: createResolver<DataModelReleaseResolvers, "organization">()
      .use(withOrgResourceClient("data_model", ({ parent }) => parent.model_id))
      .resolve(async (parent, _args, context) =>
        getOrganization(parent.org_id, context.client),
      ),
    createdAt: (parent) => parent.created_at,
    updatedAt: (parent) => parent.updated_at,
  },
};
