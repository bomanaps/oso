import { getResourcePublicPermission } from "@/app/api/v1/osograph/utils/access-control";
import {
  getOrganization,
  getUserProfile,
} from "@/app/api/v1/osograph/utils/auth";
import { ResourceErrors } from "@/app/api/v1/osograph/utils/errors";
import {
  DataIngestionsWhereSchema,
  DataModelWhereSchema,
  RunWhereSchema,
  StaticModelWhereSchema,
  MaterializationWhereSchema,
  DataConnectionAsTableWhereSchema,
} from "@/app/api/v1/osograph/utils/validation";
import type { FilterableConnectionArgs } from "@/app/api/v1/osograph/utils/pagination";
import { queryWithPagination } from "@/app/api/v1/osograph/utils/query-helpers";
import { assertNever } from "@opensource-observer/utils";
import type {
  DatasetResolvers,
  DataModelDefinitionResolvers,
  StaticModelDefinitionResolvers,
  DataIngestionDefinitionResolvers,
  DataConnectionDefinitionResolvers,
  Resolvers,
} from "@/app/api/v1/osograph/types/generated/types";
import { createResolver } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgResourceClient } from "@/app/api/v1/osograph/utils/resolver-middleware";
import { generateTableId } from "@/app/api/v1/osograph/utils/model";

export const datasetTypeResolvers: Pick<
  Resolvers,
  | "Dataset"
  | "DataModelDefinition"
  | "StaticModelDefinition"
  | "DataIngestionDefinition"
  | "DataConnectionDefinition"
  | "Table"
> = {
  Dataset: {
    displayName: (parent) => parent.display_name,
    createdAt: (parent) => parent.created_at,
    updatedAt: (parent) => parent.updated_at,
    creatorId: (parent) => parent.created_by,
    orgId: (parent) => parent.org_id,
    type: (parent) => parent.dataset_type,

    isSubscribed: createResolver<DatasetResolvers, "isSubscribed">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id, "read"))
      .resolve(async (parent, args, context) => {
        const { data } = await context.client
          .from("resource_permissions")
          .select("id")
          .eq("dataset_id", parent.id)
          .eq("org_id", args.orgId)
          .is("user_id", null)
          .is("revoked_at", null)
          .maybeSingle();
        return !!data;
      }),

    isPublic: createResolver<DatasetResolvers, "isPublic">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id, "read"))
      .resolve(async (parent, _args, context) => {
        const permission = await getResourcePublicPermission(
          parent.id,
          "dataset",
          context.client,
        );
        return permission !== "none";
      }),

    creator: createResolver<DatasetResolvers, "creator">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) =>
        getUserProfile(parent.created_by, context.client),
      ),

    organization: createResolver<DatasetResolvers, "organization">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) =>
        getOrganization(parent.org_id, context.client),
      ),

    typeDefinition: async (parent) => {
      switch (parent.dataset_type) {
        case "USER_MODEL":
          return { __typename: "DataModelDefinition" as const, ...parent };
        case "STATIC_MODEL":
          return { __typename: "StaticModelDefinition" as const, ...parent };
        case "DATA_INGESTION":
          return { __typename: "DataIngestionDefinition" as const, ...parent };
        case "DATA_CONNECTION":
          return { __typename: "DataConnectionDefinition" as const, ...parent };
        default:
          assertNever(
            parent.dataset_type,
            `Unknown dataset type: ${parent.dataset_type}`,
          );
      }
    },

    tables: createResolver<DatasetResolvers, "tables">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id, "read"))
      .resolve(async (parent, args: FilterableConnectionArgs, context) => {
        switch (parent.dataset_type) {
          // For USER_MODEL and STATIC_MODEL we get directly from the respective tables since
          // it's possible to create a model and not run a materialization.
          // For DATA_INGESTION and DATA_CONNECTION we get from the *_as_table views since
          // the tables of those types is created automatically.
          case "USER_MODEL": {
            const userModel = await queryWithPagination(args, context, {
              client: context.client,
              orgIds: parent.org_id,
              tableName: "model",
              whereSchema: DataModelWhereSchema,
              basePredicate: {
                eq: [{ key: "dataset_id", value: parent.id }],
                is: [{ key: "deleted_at", value: null }],
              },
            });
            return {
              ...userModel,
              edges: userModel.edges.map((edge) => ({
                ...edge,
                node: {
                  dataset_id: parent.id,
                  org_id: parent.org_id,
                  table_id: generateTableId("USER_MODEL", edge.node.id),
                  table_name: edge.node.name,
                },
              })),
            };
          }
          case "STATIC_MODEL": {
            const staticModel = await queryWithPagination(args, context, {
              client: context.client,
              orgIds: parent.org_id,
              tableName: "static_model",
              whereSchema: StaticModelWhereSchema,
              basePredicate: {
                eq: [{ key: "dataset_id", value: parent.id }],
                is: [{ key: "deleted_at", value: null }],
              },
            });
            return {
              ...staticModel,
              edges: staticModel.edges.map((edge) => ({
                ...edge,
                node: {
                  dataset_id: parent.id,
                  org_id: parent.org_id,
                  table_id: generateTableId("STATIC_MODEL", edge.node.id),
                  table_name: edge.node.name,
                },
              })),
            };
          }
          case "DATA_INGESTION":
            return queryWithPagination(args, context, {
              client: context.client,
              orgIds: parent.org_id,
              tableName: "data_ingestion_as_table",
              whereSchema: DataIngestionsWhereSchema,
              basePredicate: {
                eq: [{ key: "dataset_id", value: parent.id }],
              },
            });
          case "DATA_CONNECTION":
            return queryWithPagination(args, context, {
              client: context.client,
              orgIds: parent.org_id,
              tableName: "data_connection_as_table",
              whereSchema: DataConnectionAsTableWhereSchema,
              basePredicate: {
                eq: [{ key: "dataset_id", value: parent.id }],
              },
            });
          default:
            assertNever(
              parent.dataset_type,
              `Unknown dataset type: ${parent.dataset_type}`,
            );
        }
      }),

    runs: createResolver<DatasetResolvers, "runs">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id))
      .resolve(async (parent, args: FilterableConnectionArgs, context) =>
        queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "run",
          whereSchema: RunWhereSchema,
          basePredicate: {
            eq: [{ key: "dataset_id", value: parent.id }],
          },
          orderBy: {
            key: "queued_at",
            ascending: false,
          },
        }),
      ),

    materializations: createResolver<DatasetResolvers, "materializations">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id, "read"))
      .resolve(async (parent, args: FilterableConnectionArgs, context) =>
        queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "materialization",
          whereSchema: MaterializationWhereSchema,
          basePredicate: {
            eq: [{ key: "dataset_id", value: parent.id }],
          },
          orderBy: {
            key: "created_at",
            ascending: false,
          },
        }),
      ),
  },

  DataModelDefinition: {
    orgId: (parent) => parent.org_id,
    datasetId: (parent) => parent.id,
    dataModels: createResolver<DataModelDefinitionResolvers, "dataModels">()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id, "read"))
      .resolve(async (parent, args: FilterableConnectionArgs, context) =>
        queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "model",
          whereSchema: DataModelWhereSchema,
          basePredicate: {
            is: [{ key: "deleted_at", value: null }],
            eq: [{ key: "dataset_id", value: parent.id }],
          },
        }),
      ),
  },

  StaticModelDefinition: {
    orgId: (parent) => parent.org_id,
    datasetId: (parent) => parent.id,
    staticModels: createResolver<
      StaticModelDefinitionResolvers,
      "staticModels"
    >()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id, "read"))
      .resolve(async (parent, args: FilterableConnectionArgs, context) =>
        queryWithPagination(args, context, {
          client: context.client,
          orgIds: parent.org_id,
          tableName: "static_model",
          whereSchema: StaticModelWhereSchema,
          basePredicate: {
            is: [{ key: "deleted_at", value: null }],
            eq: [{ key: "dataset_id", value: parent.id }],
          },
        }),
      ),
  },

  DataIngestionDefinition: {
    orgId: (parent) => parent.org_id,
    datasetId: (parent) => parent.id,
    dataIngestion: createResolver<
      DataIngestionDefinitionResolvers,
      "dataIngestion"
    >()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) => {
        const { data: config } = await context.client
          .from("data_ingestions")
          .select("*")
          .eq("dataset_id", parent.id)
          .is("deleted_at", null)
          .maybeSingle();

        return config;
      }),
  },

  DataConnectionDefinition: {
    orgId: (parent) => parent.org_id,
    datasetId: (parent) => parent.id,
    dataConnectionAlias: createResolver<
      DataConnectionDefinitionResolvers,
      "dataConnectionAlias"
    >()
      .use(withOrgResourceClient("dataset", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) => {
        const { data: alias } = await context.client
          .from("data_connection_alias")
          .select("*")
          .eq("dataset_id", parent.id)
          .is("deleted_at", null)
          .maybeSingle();

        if (!alias)
          throw ResourceErrors.notFound("DataConnectionAlias", parent.id);
        return alias;
      }),
  },

  Table: {
    id: (parent) => parent.table_id!,
    name: (parent) => parent.table_name!,
    datasetId: (parent) => parent.dataset_id!,
  },
};
