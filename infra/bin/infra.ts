#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { LocalBridgeStack } from "../lib/infra-stack";

const app = new cdk.App();
new LocalBridgeStack(app, process.env.LOCAL_BRIDGE_STACK_NAME ?? "LocalBridgeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
