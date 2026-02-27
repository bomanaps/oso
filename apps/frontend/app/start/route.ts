import { NextRequest, NextResponse } from "next/server";
import _ from "lodash";
import { logger } from "@/lib/logger";
import { getUser } from "@/lib/auth/auth";
import { createServerClient } from "@/lib/supabase/server";
import { withPostHogTracking } from "@/lib/clients/posthog";
import { NODE_ENV } from "@/lib/config";

export const dynamic = "force-dynamic";

function urlWithSearchParams(url: string, searchParams: URLSearchParams) {
  if (searchParams.size === 0) {
    return url;
  }
  return `${url}?${searchParams.toString()}`;
}

function redirectToParam(
  param: string | null,
  label: string,
  baseUrl: string,
): NextResponse | null {
  if (!param) return null;
  try {
    const destination = new URL(param, baseUrl);
    if (destination.origin !== new URL(baseUrl).origin) {
      logger.log(`/start: Invalid ${label} param rejected: ${param}`);
      return NextResponse.redirect(new URL("/", baseUrl));
    }
    return NextResponse.redirect(destination);
  } catch {
    logger.log(`/start: Unparseable ${label} param: ${param}`);
    return NextResponse.redirect(new URL("/", baseUrl));
  }
}

export const GET = withPostHogTracking(async (req: NextRequest) => {
  const searchParams = req.nextUrl.searchParams;
  const supabaseClient = await createServerClient();
  const user = await getUser(req);

  // Check if user is anonymous
  if (user.role === "anonymous") {
    logger.log(`/start: User is anonymous`);
    return NextResponse.redirect(
      new URL(urlWithSearchParams("/login", searchParams), req.url),
    );
  }

  // NOTE: We need to remove the legacy `next` handling
  // for invites, but we want to support old links that have the invite path in the `next` param
  const nextParam = searchParams.get("next");
  const inviteParam = searchParams.get("invite");

  const legacyInvitePath = nextParam?.startsWith("/invite/") ? nextParam : null;
  const inviteRedirect = redirectToParam(
    inviteParam ?? legacyInvitePath,
    "invite",
    req.url,
  );
  if (inviteRedirect) {
    return inviteRedirect;
  }

  // Check if the user is part of any any organizations
  const { data: joinedOrgs, error: joinError } = await supabaseClient
    .from("users_by_organization")
    .select(
      "*, organizations!inner(id, org_name, created_at, pricing_plan!inner(price_per_credit))",
    )
    .eq("user_id", user.userId)
    .is("deleted_at", null);

  if (joinError) {
    throw joinError;
  } else if (!joinedOrgs || joinedOrgs.length <= 0) {
    return NextResponse.redirect(
      new URL(urlWithSearchParams("/create-org", searchParams), req.url),
    );
  }

  // Find the user's highest tier organization
  // TODO: this is a hack to find the highest tier plan
  const flattened = joinedOrgs.map((x) => ({
    id: x.organizations.id,
    org_name: x.organizations.org_name,
    price_per_credit: x.organizations.pricing_plan.price_per_credit,
    created_at: x.organizations.created_at,
  }));
  const sorted = _.sortBy(flattened, ["price_per_credit", "created_at"]);
  const org = sorted[0];

  // Look for any existing notebooks
  const { data: notebookData, error: notebookError } = await supabaseClient
    .from("notebooks")
    .select("*")
    .eq("org_id", org.id)
    .is("deleted_at", null);
  if (notebookError) {
    throw notebookError;
  } else if (!notebookData || notebookData.length <= 0) {
    // We only show the onboarding wizard in production
    if (NODE_ENV === "production") {
      return NextResponse.redirect(
        new URL(`/examples?orgName=${org.org_name}`, req.url),
      );
    }
  }

  // If there's a "next" param, redirect there
  const nextRedirect = redirectToParam(
    searchParams.get("next"),
    "next",
    req.url,
  );
  if (nextRedirect) {
    return nextRedirect;
  }

  // Default logged-in case - redirect to organization dashboard
  return NextResponse.redirect(new URL(`/${org.org_name}`, req.url));
});
