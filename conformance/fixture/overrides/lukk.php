<?php

// PARTIAL lukk config — lukk deep-merges this over its defaults (mergeConfigDeep),
// so we only state what the conformance fixture overrides; everything else
// (secret, issuer, ttls, rate limits) is backfilled from the package defaults.
//
// Features and the signing algorithm are env-driven so the conformance MATRIX
// (conformance/matrix.sh) can boot the same fixture in every combination.
return [
    'features' => [
        'two_factor' => (bool) env('LUKK_FEAT_2FA', true),
        'passkeys' => (bool) env('LUKK_FEAT_PASSKEYS', true),
        'email_verification' => (bool) env('LUKK_FEAT_EMAIL', false),
    ],

    // HS256 (default) reads LUKK_SECRET; RS256/ES256 read the keys below. The matrix
    // runner sets LUKK_ALGORITHM + generates the keypair into .env for the asymmetric runs.
    'algorithm' => env('LUKK_ALGORITHM', 'HS256'),

    // Passkeys need an explicit relying party. `origins` is a list → replaced wholesale.
    'passkeys' => [
        'rp_id' => env('LUKK_PASSKEY_RP_ID', 'localhost'),
        'origins' => array_values(array_filter(array_map(
            'trim',
            explode(',', (string) env('LUKK_PASSKEY_ORIGINS', 'http://localhost:8000')),
        ))),
    ],

    // Empty frontend_url → the verify route returns 204 to a JSON client (what the
    // node conformance flow asserts). A browser E2E app sets this to its SPA page.
    'email_verification' => [
        'frontend_url' => env('LUKK_VERIFY_URL', ''),
    ],
];
