# A minimal Laravel host running lukk, for the conformance harness.
# The Laravel app is generated at build time by build.sh (needs network).
FROM php:8.3-cli

RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip curl libonig-dev libsqlite3-dev \
    && docker-php-ext-install pdo pdo_sqlite mbstring bcmath \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
ENV COMPOSER_ALLOW_SUPERUSER=1

WORKDIR /srv
COPY . /srv/fixture/

# Toggle the lukk delivery mode at build time (compose passes this through).
ARG LUKK_COOKIE_MODE=false
ENV LUKK_COOKIE_MODE=$LUKK_COOKIE_MODE

RUN bash /srv/fixture/build.sh /srv/app

WORKDIR /srv/app
EXPOSE 8000
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]
