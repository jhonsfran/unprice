import { createTRPCRouter } from "#trpc"
import { analyticsRouter } from "./analytics"
import { apiKeyRouter } from "./apikeys"
import { authRouter } from "./auth"
import { customersRouter } from "./customers"
import { domainRouter } from "./domains"
import { eventRouter } from "./events"
import { featureRouter } from "./features"
import { pageRouter } from "./pages"
import { paymentProviderRouter } from "./paymentProvider"
import { planVersionFeatureRouter } from "./planVersionFeatures"
import { planVersionRouter } from "./planVersions"
import { planRouter } from "./plans"
import { projectRouter } from "./projects"
import { subscriptionRouter } from "./subscriptions"
import { walletsRouter } from "./wallets"
import { workspaceRouter } from "./workspaces"

// Deployed to /trpc/lambda/**
// for some reason edge engine is not working for some endpoints
// everything is edge ready but only this endpoints works properly in vercel.
// I'll migrate to cloudflare workers in the future
export const lambdaEndpoints = {
  planVersionFeatures: planVersionFeatureRouter,
  workspaces: workspaceRouter,
  projects: projectRouter,
  plans: planRouter,
  planVersions: planVersionRouter,
  auth: authRouter,
  apikeys: apiKeyRouter,
  features: featureRouter,
  subscriptions: subscriptionRouter,
  domains: domainRouter,
  events: eventRouter,
  customers: customersRouter,
  pages: pageRouter,
  paymentProvider: paymentProviderRouter,
  analytics: analyticsRouter,
  wallets: walletsRouter,
}

export const lambdaRouter = createTRPCRouter(lambdaEndpoints)
