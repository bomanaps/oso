import { logger } from "@/lib/logger";
import { ServerErrors } from "@/app/api/v1/osograph/utils/errors";
import type { MutationResolvers } from "@/app/api/v1/osograph/types/generated/types";
import { createResolversCollection } from "@/app/api/v1/osograph/utils/resolver-builder";
import {
  withValidation,
  withOrgResourceClient,
} from "@/app/api/v1/osograph/utils/resolver-middleware";
import {
  GrantResourcePermissionInputSchema,
  ResourceTypeSchema,
} from "@/app/api/v1/osograph/types/generated/validation";
import {
  RESOURCE_CONFIG,
  LocalResourceTypeSchema,
} from "@/app/api/v1/osograph/utils/access-control";

type PermissionMutationResolvers = Pick<
  Required<MutationResolvers>,
  "grantResourcePermission"
>;

/**
 * Generic resource permission mutations.
 */
export const permissionMutations =
  createResolversCollection<PermissionMutationResolvers>()
    .defineWithBuilder("grantResourcePermission", (builder) =>
      builder
        .use(withValidation(GrantResourcePermissionInputSchema()))
        .use(
          withOrgResourceClient(
            ({ args }) =>
              LocalResourceTypeSchema.parse(
                ResourceTypeSchema.parse(args.input.resourceType).toLowerCase(),
              ),
            ({ args }) => args.input.id,
            "admin",
          ),
        )
        .resolve(async (_, { input }, context) => {
          const resourceConfigKey = LocalResourceTypeSchema.parse(
            ResourceTypeSchema.parse(input.resourceType).toLowerCase(),
          );
          const resourceConfig = RESOURCE_CONFIG[resourceConfigKey];

          switch (input.permissionLevel.toLowerCase()) {
            case "none": {
              let query = context.client
                .from("resource_permissions")
                .update({ revoked_at: new Date().toISOString() })
                .is("revoked_at", null)
                .eq(resourceConfig.permissionColumn, input.id);

              if (input.targetUserId != null) {
                query = query.eq("user_id", input.targetUserId);
              } else {
                query = query.is("user_id", null);
              }
              if (input.targetOrgId != null) {
                query = query.eq("org_id", input.targetOrgId);
              } else {
                query = query.is("org_id", null);
              }

              logger.info("Revoking resource permission for", { input });

              const { error: revokeError } = await query;
              if (revokeError) {
                logger.error(
                  "Failed to revoke resource permission:",
                  revokeError,
                );
                throw ServerErrors.database(
                  `Failed to revoke resource permission: ${revokeError.message}`,
                );
              }
              return {
                success: true,
                message: "Permission revoked successfully",
              };
            }

            case "read":
            case "write":
            case "admin": {
              const insertData = {
                [resourceConfig.permissionColumn]: input.id,
                user_id: input.targetUserId ?? null,
                org_id: input.targetOrgId ?? null,
                permission_level: input.permissionLevel.toLowerCase(),
                granted_by: context.authenticatedUser?.userId ?? null,
              };

              logger.info("Granting resource permission with insert data", {
                insertData,
              });

              const { error: insertError } = await context.client
                .from("resource_permissions")
                .insert(insertData);

              if (insertError) {
                if (insertError.code === "23505") {
                  logger.warn("Permission already exists, skipping insert:", {
                    insertData,
                  });
                  return {
                    success: true,
                    message: "Permission already exists",
                  };
                }
                logger.error(
                  "Failed to grant resource permission:",
                  insertError,
                );
                throw ServerErrors.database(
                  `Failed to grant resource permission: ${insertError.message}`,
                );
              }

              let message = "Permission granted successfully";
              if (!input.targetUserId && !input.targetOrgId) {
                message = `Resource is now public with ${input.permissionLevel} access`;
              } else if (input.targetOrgId) {
                message = "Permission granted to organization";
              } else if (input.targetUserId) {
                message = "Permission granted to user";
              }

              return { success: true, message };
            }

            default:
              throw ServerErrors.internal(
                `Permission level ${input.permissionLevel} not implemented`,
              );
          }
        }),
    )
    .resolvers();
