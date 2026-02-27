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
  executePreviewQuery,
  generateTableId,
} from "@/app/api/v1/osograph/utils/model";
import { createResolver } from "@/app/api/v1/osograph/utils/resolver-builder";
import { withOrgResourceClient } from "@/app/api/v1/osograph/utils/resolver-middleware";
import type {
  Resolvers,
  StaticModelResolvers,
} from "@/app/api/v1/osograph/types/generated/types";

export const staticModelTypeResolvers: Required<
  Pick<Resolvers, "StaticModel">
> = {
  StaticModel: {
    orgId: (parent) => parent.org_id,

    createdAt: (parent) => parent.created_at,

    updatedAt: (parent) => parent.updated_at,

    organization: createResolver<StaticModelResolvers, "organization">()
      .use(withOrgResourceClient("static_model", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) => {
        return getOrganization(parent.org_id, context.client);
      }),

    dataset: createResolver<StaticModelResolvers, "dataset">()
      .use(withOrgResourceClient("static_model", ({ parent }) => parent.id))
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

    runs: createResolver<StaticModelResolvers, "runs">()
      .use(withOrgResourceClient("static_model", ({ parent }) => parent.id))
      .resolve(async (parent, args, context) => {
        return getModelRunConnection(
          parent.dataset_id,
          parent.id,
          args,
          context.client,
        );
      }),

    modelContext: createResolver<StaticModelResolvers, "modelContext">()
      .use(withOrgResourceClient("static_model", ({ parent }) => parent.id))
      .resolve(async (parent, _args, context) => {
        return getModelContext(parent.dataset_id, parent.id, context.client);
      }),

    materializations: createResolver<StaticModelResolvers, "materializations">()
      .use(withOrgResourceClient("static_model", ({ parent }) => parent.id))
      .resolve(async (parent, args, context) => {
        return getMaterializations(
          args,
          context,
          parent.org_id,
          parent.dataset_id,
          generateTableId("STATIC_MODEL", parent.id),
          context.client,
        );
      }),

    previewData: createResolver<StaticModelResolvers, "previewData">()
      .use(
        withOrgResourceClient(
          "static_model",
          ({ parent }) => parent.id,
          "read",
        ),
      )
      .resolve(async (parent, _args, context) => {
        const tableId = generateTableId("STATIC_MODEL", parent.id);

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
};
