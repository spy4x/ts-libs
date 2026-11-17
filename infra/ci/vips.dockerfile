# The image of the `vips` step in `.woodpecker.yml` (#962): the pinned Deno image with the image
# tools `deno task test:vips` runs, baked in, so the step no longer spends a minute on apt-get.
# libvips with the HEIC decoder and AVIF codecs it reads and writes, the HEVC encoder the test makes
# its HEIC sample with, and exiftool, which checks that no metadata is left.
#
# Rebuild it when the Deno version or this list changes, from the repository root of a checkout
# of `main`, with the Docker Hub login of `DOCKERHUB_USERNAME` (~/sync/code/homelab/.env.accounts),
# then raise the `-N` suffix, pin the digest `docker push` prints in the `vips` step and move the
# tag in `docs/testing.md`, "The vips tier":
#
#   docker build -f infra/ci/vips.dockerfile -t antonshubin/ts-libs-ci:vips-deno2.9.7-1 infra/ci
#   docker push antonshubin/ts-libs-ci:vips-deno2.9.7-1
FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends libvips-tools libheif-plugin-libde265 \
    libheif-plugin-aomenc libheif-plugin-dav1d libheif-plugin-x265 libimage-exiftool-perl \
  && rm -rf /var/lib/apt/lists/*
