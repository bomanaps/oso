import { createResolversCollection } from "@/app/api/v1/osograph/utils/resolver-builder";
import {
  withAuthenticatedClient,
  withValidation,
} from "@/app/api/v1/osograph/utils/resolver-middleware";
import { logger } from "@/lib/logger";
import type { MutationResolvers } from "@/app/api/v1/osograph/types/generated/types";

type InvitationMutationResolvers = Pick<
  Required<MutationResolvers>,
  "acceptInvitation"
>;
import { AcceptInvitationSchema } from "@/app/api/v1/osograph/utils/validation";
import {
  InvitationErrors,
  ServerErrors,
} from "@/app/api/v1/osograph/utils/errors";

export const invitationMutations: InvitationMutationResolvers =
  createResolversCollection<InvitationMutationResolvers>()
    .defineWithBuilder("acceptInvitation", (builder) => {
      return builder
        .use(withValidation(AcceptInvitationSchema))
        .use(withAuthenticatedClient())
        .resolve(async (_, { input }, context) => {
          const { data: invitation, error: invError } = await context.client
            .from("invitations")
            .select("*")
            .eq("id", input.invitationId)
            .single();

          if (invError || !invitation) {
            throw InvitationErrors.notFound();
          }

          if (invitation.accepted_at) {
            throw InvitationErrors.alreadyAccepted();
          }

          if (invitation.deleted_at) {
            throw InvitationErrors.revoked();
          }

          if (new Date(invitation.expires_at) < new Date()) {
            throw InvitationErrors.expired();
          }

          if (context.user.role !== "user" || !context.user.email) {
            throw InvitationErrors.wrongRecipient();
          }

          const userEmail = context.user.email.toLowerCase();
          if (userEmail !== invitation.email.toLowerCase()) {
            throw InvitationErrors.wrongRecipient();
          }

          const { data: existingMembership } = await context.client
            .from("users_by_organization")
            .select("*")
            .eq("user_id", context.userId)
            .eq("org_id", invitation.org_id)
            .is("deleted_at", null)
            .single();

          if (existingMembership) {
            throw InvitationErrors.alreadyAccepted();
          }

          const { error: acceptError } = await context.client
            .from("invitations")
            .update({
              accepted_at: new Date().toISOString(),
              accepted_by: context.userId,
            })
            .eq("id", input.invitationId);

          if (acceptError) {
            throw ServerErrors.database(
              `Failed to accept invitation: ${acceptError.message}`,
            );
          }

          const { data: restoredMember } = await context.client
            .from("users_by_organization")
            .update({ deleted_at: null, user_role: "admin" })
            .eq("user_id", context.userId)
            .eq("org_id", invitation.org_id)
            .not("deleted_at", "is", null)
            .select()
            .maybeSingle();

          const { data: member, error: memberError } = restoredMember
            ? { data: restoredMember, error: null }
            : await context.client
                .from("users_by_organization")
                .insert({
                  user_id: context.userId,
                  org_id: invitation.org_id,
                  user_role: "admin",
                })
                .select()
                .single();

          if (memberError) {
            logger.error("Failed to create membership:", memberError);
            throw ServerErrors.database(
              `Failed to create membership: ${memberError.message}`,
            );
          }

          return {
            member,
            message: "Invitation accepted successfully",
            success: true,
          };
        });
    })
    .resolvers();
