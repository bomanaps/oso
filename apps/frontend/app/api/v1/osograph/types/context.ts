import type { SystemCredentials } from "@/lib/types/system";
import type { User } from "@/lib/types/user";
import type { SupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  OrgRole,
  OrgScope,
  PermissionLevel,
} from "@/app/api/v1/osograph/utils/access-control";
import type { requireAuthentication } from "@/app/api/v1/osograph/utils/auth";

export type AuthenticatedUser = Extract<User, { role: "user" }>;

export type AuthCache = {
  /** Maps "userId:orgId" to the user's role in that organization */
  orgMemberships: Map<string, string>;
  /** Maps "userId:resourceType:resourceId" to the user's permission level on that resource */
  resourcePermissions: Map<string, string>;
  /** Maps "userId:resourceType:resourceId" to the resource's org ID */
  resourceOrgIds: Map<string, string>;
  /** Maps userId to the user's organization IDs */
  orgIds: Map<string, string[]>;
};

export type GraphQLContext = {
  req: Request;
  user: User;
  systemCredentials?: SystemCredentials;
  authCache: AuthCache;
};

/**
 * Enhanced context types with branded types for compile-time tracking of middleware application.
 *
 * These types use TypeScript's branded types pattern to ensure that resolver handlers
 * can only access certain context properties (like `client`, `userId`, `orgRole`) if the
 * appropriate middleware has been applied through the resolver builder.
 *
 * There are exactly 4 context types, one per access-control tier:
 *
 * | Directory       | Middleware                    | Context Type                 |
 * |-----------------|-------------------------------|------------------------------|
 * | organization/   | withOrgScopedClient(getOrgId) | OrgScopedContext             |
 * | user/           | withAuthenticatedClient()     | AuthenticatedClientContext   |
 * | resource/       | withOrgResourceClient(...)    | ResourceScopedContext        |
 * | system/         | withSystemClient()            | SystemContext                |
 */

// Branded type markers (unique symbols for compile-time tracking)
declare const OrgScopedBrand: unique symbol;
declare const AuthenticatedClientBrand: unique symbol;
declare const ResourceScopedBrand: unique symbol;
declare const SystemBrand: unique symbol;
// Brands are compile-time only (never set at runtime).
// resolver-middleware.ts satisfies them via intentional `as BrandedType` casts.

/**
 * Enhanced context type after org-scoped middleware.
 *
 * Guarantees that:
 * - User is authenticated and is a member of the org
 * - `client` is a Supabase admin client
 * - `orgId`, `orgRole`, `userId` are available
 * - `authenticatedUser` is the full user object (needed for external service calls)
 *
 * Applied by: `withOrgScopedClient(getOrgId)` middleware
 * Used in: organization/** resolvers
 */
export type OrgScopedContext = GraphQLContext & {
  [OrgScopedBrand]: true;
  client: SupabaseAdminClient;
  orgId: string;
  orgRole: OrgRole;
  userId: string;
  authenticatedUser: ReturnType<typeof requireAuthentication> | null;
};

/**
 * Enhanced context type after authenticated client middleware.
 *
 * Guarantees that:
 * - User is authenticated (not anonymous)
 * - `client` is a Supabase admin client
 * - `userId` is available
 * - `orgIds` are scoped by token type (API token → [tokenOrgId], PAT → all user orgs)
 * - `orgScope` describes the authentication scope
 * - `authenticatedUser` is the full user object (needed for external service calls)
 *
 * Applied by: `withAuthenticatedClient()` middleware
 * Used in: user/** resolvers
 */
export type AuthenticatedClientContext = GraphQLContext & {
  [AuthenticatedClientBrand]: true;
  client: SupabaseAdminClient;
  userId: string;
  orgIds: string[];
  orgScope: OrgScope;
  authenticatedUser: ReturnType<typeof requireAuthentication> | null;
};

/**
 * Enhanced context type after resource-scoped middleware.
 *
 * Guarantees that:
 * - User is authenticated and has the required permission on the resource
 * - `client` is a Supabase admin client
 * - `permissionLevel` is the user's effective permission (never "none")
 * - `resourceId` is the resource being accessed
 * - `authenticatedUser` is the full user object (needed for JWT signing, Trino queries, etc.)
 *
 * Applied by: `withOrgResourceClient(resourceType, getResourceId, permission?)` middleware
 * Used in: resource/** resolvers
 */
export type ResourceScopedContext = GraphQLContext & {
  [ResourceScopedBrand]: true;
  client: SupabaseAdminClient;
  permissionLevel: Exclude<PermissionLevel, "none">;
  resourceId: string;
  orgId: string;
  authenticatedUser: ReturnType<typeof requireAuthentication> | null;
};

/**
 * Enhanced context type after system client middleware.
 *
 * Guarantees that:
 * - System credentials are present (internal system call, not user-facing)
 * - `client` is a Supabase admin client with full access
 *
 * Applied by: `withSystemClient()` middleware
 * Used in: system/** resolvers
 */
export type SystemContext = GraphQLContext & {
  [SystemBrand]: true;
  client: SupabaseAdminClient;
};
