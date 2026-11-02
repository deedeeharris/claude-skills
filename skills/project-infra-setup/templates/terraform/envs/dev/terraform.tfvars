project_id = "REPLACE-dev-project-id"
region     = "us-central1"

# Copying this root to envs/prod: set env = "prod", point backend.tf at the prod bucket and prefix envs/prod,
# pin secret_version to a number, delete preview_deployer_sa and registry_writer_sas, and set registry_reader_members = [].
# `image` is never set here: CI passes -var image=<digest> on every plan (operator's first apply: the hello placeholder).
env = "dev"

# Emails come from the dev bootstrap outputs image_pusher_sa and preview_deployer_sa.
registry_writer_sas = ["image-pusher@REPLACE-dev-project-id.iam.gserviceaccount.com"]
preview_deployer_sa = "preview-deployer@REPLACE-dev-project-id.iam.gserviceaccount.com"

# Prod pulls the dev-built digest: BOTH the prod project's Cloud Run service agent AND the prod applier (tf-applier-prod,
# output applier_sa of the prod bootstrap) need read on the dev registry (Cloud Run checks the deployer and the service agent).
# registry_reader_members = [
#   "serviceAccount:service-<PROD_PROJECT_NUMBER>@serverless-robot-prod.iam.gserviceaccount.com",
#   "serviceAccount:tf-applier-prod@<PROD_PROJECT_ID>.iam.gserviceaccount.com",
# ]

# Two-step secrets: apply once with false (creates empty secret containers), add a version to each secret
# out of band, then set true and apply again.
mount_secrets  = false
secret_version = "latest"
