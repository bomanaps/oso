import { GraphQLContext } from "@/app/api/v1/osograph/types/context";
import {
  getOrganization,
  requireOrgMembership,
} from "@/app/api/v1/osograph/utils/auth";
import {
  buildConnection,
  type Connection,
  emptyConnection,
} from "@/app/api/v1/osograph/utils/connection";
import {
  ResourceErrors,
  ServerErrors,
} from "@/app/api/v1/osograph/utils/errors";
import type {
  ConnectionArgs,
  FilterableConnectionArgs,
} from "@/app/api/v1/osograph/utils/pagination";
import {
  buildQuery,
  mergePredicates,
  type QueryPredicate,
} from "@/app/api/v1/osograph/utils/query-builder";
import {
  maybeAddQueryPagination,
  queryWithPagination,
} from "@/app/api/v1/osograph/utils/query-helpers";
import { MaterializationWhereSchema } from "@/app/api/v1/osograph/utils/validation";
import {
  createAdminClient,
  type SupabaseAdminClient,
} from "@/lib/supabase/admin";
import { Database } from "@/lib/types/supabase";
import { logger } from "@/lib/logger";
import {
  invitationsRowSchema,
  organizationsRowSchema,
  runRowSchema,
} from "@/lib/types/schema";
import type { DatasetsRow, MaterializationRow } from "@/lib/types/schema-types";
import { z } from "zod";

export function buildConnectionOrEmpty<T>(
  data: T[] | null | undefined,
  args: ConnectionArgs,
  count: number | null,
): Connection<T> {
  if (!data || data.length === 0) {
    return emptyConnection();
  }
  return buildConnection(data, args, count ?? 0);
}

export async function getDatasetById(
  datasetId: string,
  adminClient?: SupabaseAdminClient,
): Promise<DatasetsRow> {
  const client = adminClient ?? createAdminClient();
  const { data: dataset, error: datasetError } = await client
    .from("datasets")
    .select("*")
    .eq("id", datasetId)
    .single();

  if (datasetError || !dataset) {
    throw ResourceErrors.notFound("Dataset", datasetId);
  }

  return dataset;
}

/** @deprecated - use `getAuthenticatedClient(context).orgIds` instead for proper org scoping */
export async function getUserOrganizationIds(
  userId: string,
  adminClient: SupabaseAdminClient,
): Promise<string[]>;
/** @deprecated - use `getAuthenticatedClient(context).orgIds` instead for proper org scoping */
export async function getUserOrganizationIds(userId: string): Promise<string[]>;
export async function getUserOrganizationIds(
  userId: string,
  adminClient?: SupabaseAdminClient,
): Promise<string[]> {
  const supabase = adminClient ?? createAdminClient();

  const { data: memberships } = await supabase
    .from("users_by_organization")
    .select("org_id")
    .eq("user_id", userId)
    .is("deleted_at", null);

  return memberships?.map((m) => m.org_id) || [];
}

export async function getUserOrganizationsConnection(
  userId: string,
  args: FilterableConnectionArgs,
  additionalPredicate: Partial<QueryPredicate<"organizations">> | undefined,
  adminClient: SupabaseAdminClient,
  allowedOrgIds: string[],
): Promise<Connection<z.infer<typeof organizationsRowSchema>>>;
/** @deprecated - use overload with `adminClient` and `allowedOrgIds` from `getAuthenticatedClient(context).orgIds` */
export async function getUserOrganizationsConnection(
  userId: string,
  args: FilterableConnectionArgs,
  additionalPredicate?: Partial<QueryPredicate<"organizations">>,
): Promise<Connection<z.infer<typeof organizationsRowSchema>>>;
export async function getUserOrganizationsConnection(
  userId: string,
  args: FilterableConnectionArgs,
  additionalPredicate?: Partial<QueryPredicate<"organizations">>,
  adminClient?: SupabaseAdminClient,
  allowedOrgIds?: string[],
) {
  const supabase = adminClient ?? createAdminClient();

  const membershipPredicate: Partial<QueryPredicate<"users_by_organization">> =
    {
      eq: [{ key: "user_id", value: userId }],
      is: [{ key: "deleted_at", value: null }],
    };

  if (allowedOrgIds) {
    membershipPredicate.in = [{ key: "org_id", value: allowedOrgIds }];
  }

  const {
    data: memberships,
    count: membershipCount,
    error: membershipError,
  } = await buildQuery(
    supabase,
    "users_by_organization",
    membershipPredicate,
    (query) => maybeAddQueryPagination(query, args),
  );

  if (membershipError) {
    throw ServerErrors.database(
      `Failed to fetch memberships: ${membershipError.message}`,
    );
  }

  if (!memberships || memberships.length === 0) {
    return emptyConnection();
  }

  const orgIds = memberships.map((m) => m.org_id);

  const basePredicate: Partial<QueryPredicate<"organizations">> = {
    in: [{ key: "id", value: orgIds }],
  };

  const predicate = additionalPredicate
    ? mergePredicates(basePredicate, additionalPredicate)
    : basePredicate;

  const { data: organizations, error: orgError } = await buildQuery(
    supabase,
    "organizations",
    predicate,
    undefined,
    { single: args.single ?? undefined },
  );

  if (orgError) {
    throw ServerErrors.database(
      `Failed to fetch organizations: ${orgError.message}`,
    );
  }

  return buildConnectionOrEmpty(organizations, args, membershipCount);
}

export async function getUserInvitationsConnection(
  email: string | null | undefined,
  args: ConnectionArgs,
  additionalPredicate: Partial<QueryPredicate<"invitations">> | undefined,
  adminClient: SupabaseAdminClient,
): Promise<Connection<z.infer<typeof invitationsRowSchema>>>;
/** @deprecated - use `getUserInvitationsConnection` with extra client parameter */
export async function getUserInvitationsConnection(
  email: string | null | undefined,
  args: ConnectionArgs,
  additionalPredicate?: Partial<QueryPredicate<"invitations">>,
): Promise<Connection<z.infer<typeof invitationsRowSchema>>>;
export async function getUserInvitationsConnection(
  email: string | null | undefined,
  args: ConnectionArgs,
  additionalPredicate?: Partial<QueryPredicate<"invitations">>,
  adminClient?: SupabaseAdminClient,
) {
  if (!email) {
    return emptyConnection();
  }

  const supabase = adminClient ?? createAdminClient();
  const userEmail = email.toLowerCase();

  const basePredicate: Partial<QueryPredicate<"invitations">> = {
    ilike: [{ key: "email", value: userEmail }],
    is: [
      { key: "accepted_at", value: null },
      { key: "deleted_at", value: null },
    ],
    gt: [{ key: "expires_at", value: new Date().toISOString() }],
  };

  const predicate = additionalPredicate
    ? mergePredicates(basePredicate, additionalPredicate)
    : basePredicate;

  const {
    data: invitations,
    count,
    error,
  } = await buildQuery(supabase, "invitations", predicate, (query) =>
    maybeAddQueryPagination(query, args),
  );

  if (error) {
    throw ServerErrors.database(
      `Failed to fetch invitations: ${error.message}`,
    );
  }

  return buildConnectionOrEmpty(invitations, args, count);
}

export async function requireOrganizationAccess(userId: string, orgId: string) {
  const org = await getOrganization(orgId);
  await requireOrgMembership(userId, org.id);
  return org;
}

type TableWithId = {
  [T in keyof Database["public"]["Tables"]]: Database["public"]["Tables"][T]["Row"] extends {
    id: string;
    deleted_at: string | null;
  }
    ? T
    : never;
}[keyof Database["public"]["Tables"]];

export async function getResourceById<T extends TableWithId>(
  tableName: T,
  id: string,
  client: SupabaseAdminClient,
) {
  const { data, error } = await client
    .from(tableName)
    .select("*")
    // @ts-expect-error - T is constrained to tables with string id and deleted_at, but TS can't infer that here
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  return error || !data ? null : data;
}

export async function checkMembershipExists(
  userId: string,
  orgId: string,
  adminClient: SupabaseAdminClient,
): Promise<boolean>;
/** @deprecated - use `checkMembershipExists` with extra client parameter */
export async function checkMembershipExists(
  userId: string,
  orgId: string,
): Promise<boolean>;
export async function checkMembershipExists(
  userId: string,
  orgId: string,
  adminClient?: SupabaseAdminClient,
): Promise<boolean> {
  const supabase = adminClient ?? createAdminClient();

  const { data: existingMembership } = await supabase
    .from("users_by_organization")
    .select("*")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .single();

  return !!existingMembership;
}

export async function getModelRunConnection(
  datasetId: string,
  modelId: string,
  args: ConnectionArgs,
  adminClient: SupabaseAdminClient,
): Promise<Connection<z.infer<typeof runRowSchema>>>;
/** @deprecated - use `getModelRunConnection` with extra client parameter */
export async function getModelRunConnection(
  datasetId: string,
  modelId: string,
  args: ConnectionArgs,
): Promise<Connection<z.infer<typeof runRowSchema>>>;
export async function getModelRunConnection(
  datasetId: string,
  modelId: string,
  args: ConnectionArgs,
  adminClient?: SupabaseAdminClient,
) {
  const supabase = adminClient ?? createAdminClient();
  const { data, count, error } = await supabase
    .from("run")
    .select("*")
    .eq("dataset_id", datasetId)
    .or(`models.cs.{"${modelId}"},models.eq.{}`) // If the run contains the model ID or is an empty array
    .order("queued_at", { ascending: false });

  if (error) {
    throw ServerErrors.database(`Failed to fetch runs: ${error.message}`);
  }

  return buildConnectionOrEmpty(data, args, count);
}

/** @deprecated - use `getMaterializations` with extra client parameters */
export async function getMaterializations(
  args: FilterableConnectionArgs,
  context: GraphQLContext,
  orgId: string,
  datasetId: string,
  tableId: string,
): Promise<Connection<MaterializationRow>>;
export async function getMaterializations(
  args: FilterableConnectionArgs,
  context: GraphQLContext,
  orgId: string,
  datasetId: string,
  tableId: string,
  client: SupabaseAdminClient,
): Promise<Connection<MaterializationRow>>;
export async function getMaterializations(
  args: FilterableConnectionArgs,
  context: GraphQLContext,
  orgId: string,
  datasetId: string,
  tableId: string,
  client?: SupabaseAdminClient,
): Promise<Connection<MaterializationRow>> {
  if (client) {
    return queryWithPagination(args, context, {
      client,
      tableName: "materialization",
      whereSchema: MaterializationWhereSchema,
      orgIds: [orgId],
      basePredicate: {
        eq: [
          { key: "dataset_id", value: datasetId },
          {
            key: "table_id",
            value: tableId,
          },
        ],
      },
      orderBy: {
        key: "created_at",
        ascending: false,
      },
    });
  }
  return queryWithPagination(args, context, {
    tableName: "materialization",
    whereSchema: MaterializationWhereSchema,
    requireAuth: false,
    filterByUserOrgs: false,
    parentOrgIds: orgId,
    basePredicate: {
      eq: [
        { key: "dataset_id", value: datasetId },
        {
          key: "table_id",
          value: tableId,
        },
      ],
    },
    orderBy: {
      key: "created_at",
      ascending: false,
    },
  });
}

export async function getModelContext(
  datasetId: string,
  tableId: string,
  client: SupabaseAdminClient,
) {
  const { data, error } = await client
    .from("model_contexts")
    .select("*")
    .eq("dataset_id", datasetId)
    .eq("table_id", tableId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    logger.error(
      `Error fetching model context for ${datasetId}/${tableId}: ${error.message}`,
    );
    throw ServerErrors.database("Failed to fetch model context");
  }

  if (!data) return null;

  return data;
}
