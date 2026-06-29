<?php

// PARTIAL lukk config — lukk deep-merges this over its defaults (mergeConfigDeep),
// so we only state what the conformance fixture overrides; everything else
// (secret, issuer, ttls, rate limits) is backfilled from the package defaults.
return [
    'features' => [
        'two_factor' => true,
        'passkeys' => true,
    ],

    // Passkeys need an explicit relying party. `origins` is a list → replaced wholesale.
    'passkeys' => [
        'rp_id' => env('LUKK_PASSKEY_RP_ID', 'localhost'),
        'origins' => array_values(array_filter(array_map(
            'trim',
            explode(',', (string) env('LUKK_PASSKEY_ORIGINS', 'http://localhost:8000')),
        ))),
    ],
];
