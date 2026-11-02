#!/usr/bin/env bash
# EXPERIMENTAL (project-infra-setup): validated statically, not yet run against a live GCP project. Prove the gates first.
# CI helpers for the Terraform workflows (copy to scripts/tf-ci.sh in the repo). Needs gcloud, jq, an authenticated job.
#   tf-ci.sh state-check                                   run inside terraform/envs/<env>
#   tf-ci.sh live-image <service> <region> <project>       prints the image the service runs now
#   tf-ci.sh verify <service> <region> <project> <image>   after an apply: the SERVING revision runs <image>'s digest
set -euo pipefail

cmd="${1:-}"
shift || true

case "$cmd" in
  state-check)
    # The first apply by the operator creates the state object. The GCS backend would WRITE an empty state object when
    # none exists, which the read-only planner cannot do, so fail here with a clear message instead.
    bucket=$(sed -n 's/^[[:space:]]*bucket[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' backend.tf | head -n 1)
    prefix=$(sed -n 's/^[[:space:]]*prefix[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' backend.tf | head -n 1)
    if [ -z "$bucket" ] || [ -z "$prefix" ] || [[ "$bucket" == REPLACE* ]]; then
      echo "::error::backend.tf has no real bucket/prefix (placeholder left in place?)"
      exit 1
    fi
    if ! err=$(gcloud storage objects describe "gs://${bucket}/${prefix}/default.tfstate" --format='value(name)' 2>&1 >/dev/null); then
      echo "::error::state object gs://${bucket}/${prefix}/default.tfstate is missing or unreadable. The operator must run the one-time first apply for this environment (SKILL.md section 5, step 8) before CI can plan. gcloud said: ${err}"
      exit 1
    fi
    echo "state object present: gs://${bucket}/${prefix}/default.tfstate"
    ;;

  live-image)
    service="$1"; region="$2"; project="$3"
    # No fallback on error: a missing service means the first apply has not happened, and guessing an image here
    # could roll a service back. Read the image of the revision actually SERVING traffic, not the desired template:
    # after a failed rollout or a traffic rollback the template can name an image nobody is serving.
    rev=$(gcloud run services describe "$service" --region "$region" --project "$project" --format=json \
      | jq -er '[.status.traffic[]? | select((.percent // 0) > 0)] | if length == 1 then .[0].revisionName else error("traffic is not on exactly one revision") end')
    gcloud run revisions describe "$rev" --region "$region" --project "$project" --format=json \
      | jq -er '.status.imageDigest // error("serving revision has no resolved imageDigest")'
    ;;

  verify)
    service="$1"; region="$2"; project="$3"; image="$4"
    json=$(gcloud run services describe "$service" --region "$region" --project "$project" --format=json)
    serving=$(echo "$json" | jq -r '[.status.traffic[]? | select((.percent // 0) > 0)] | if length == 1 then .[0].revisionName else "AMBIGUOUS" end')
    latest=$(echo "$json" | jq -r '.status.latestReadyRevisionName // ""')
    echo "serving revision: $serving (latest ready: $latest)"
    if [ "$serving" = "AMBIGUOUS" ] || [ -z "$serving" ]; then
      echo "::error::traffic is not on exactly one revision"
      exit 1
    fi
    if [ "$serving" != "$latest" ]; then
      echo "::error::traffic is not on the latest ready revision"
      exit 1
    fi
    case "$image" in
      *@sha256:*) ;;
      *) echo "image '$image' is not digest-pinned (placeholder): digest check skipped"; exit 0 ;;
    esac
    expected="${image#*@}"
    running=$(gcloud run revisions describe "$serving" --region "$region" --project "$project" --format=json | jq -r '.status.imageDigest // ""')
    echo "running: $running"
    echo "expected: $expected"
    case "$running" in
      *"$expected") echo "digest match" ;;
      *) echo "::error::DIGEST MISMATCH"; exit 1 ;;
    esac
    ;;

  *)
    echo "usage: tf-ci.sh state-check | live-image <service> <region> <project> | verify <service> <region> <project> <image>" >&2
    exit 2
    ;;
esac
