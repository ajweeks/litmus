# Verifier eval: cases

Each case is one claim given to `verifyClaim` with a short user question as context.
- **Verdict:** the best answer, plus any other answers the grader also accepts.
- **Should show?** says whether a user should see the claim flagged at the default setting (moderate and major errors). Real errors should be shown. True claims, nitpicks and unknowables should stay quiet.

Grading is described in `grading.md`.

| # | id | category | claim | verdict (also ok) | should show? | why |
|---|---|---|---|---|---|---|
| 1 | `true-versailles` | true-known | The Treaty of Versailles was signed on 28 June 1919. | **supported** | no | Signed in the Hall of Mirrors, 28 June 1919. |
| 2 | `true-tungsten` | true-known | The chemical symbol for tungsten is W. | **supported** | no | W, from 'wolfram'. |
| 3 | `true-curie` | true-known | Marie Curie won Nobel Prizes in both Physics (1903) and Chemistry (1911). | **supported** | no | Physics 1903 (shared), Chemistry 1911. |
| 4 | `true-pacific` | true-known | The Pacific Ocean is the largest ocean on Earth by surface area. | **supported** | no | About 165 million km². |
| 5 | `true-http418` | true-known | HTTP status code 418 'I'm a teapot' was defined in RFC 2324. | **supported** | no | RFC 2324 (HTCPCP, April 1998). |
| 6 | `obscure-philae` | true-obscure | The Philae lander touched down on comet 67P/Churyumov–Gerasimenko on 12 November 2014. | **supported** | no | ESA Rosetta mission; landing 12 Nov 2014. |
| 7 | `obscure-python` | true-obscure | Python's first public release, version 0.9.0, was published in February 1991. | **supported** | no | Posted to alt.sources on 20 Feb 1991. |
| 8 | `obscure-seedvault` | true-obscure | The Svalbard Global Seed Vault officially opened in February 2008. | **supported** | no | Opened 26 Feb 2008. |
| 9 | `obscure-baikal` | true-obscure | Lake Baikal is the deepest lake in the world, with a maximum depth of about 1,640 metres. | **supported** | no | Max depth ~1,642 m. |
| 10 | `obscure-hubble` | true-obscure | The Hubble Space Telescope was launched aboard Space Shuttle Discovery in April 1990. | **supported** | no | STS-31, 24 April 1990. |
| 11 | `obscure-telegraph` | true-obscure | The first transatlantic telegraph cable was completed in 1858. | **supported** | no | Completed Aug 1858; failed within weeks (1866 cable was the first durable one). |
| 12 | `surprising-oxford` | true-surprising | Teaching at the University of Oxford began before the Aztec city of Tenochtitlan was founded. | **supported** | no | Teaching at Oxford existed by 1096; Tenochtitlan founded c. 1325. |
| 13 | `surprising-cleopatra` | true-surprising | Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid of Giza. | **supported** | no | Cleopatra d. 30 BC; pyramid c. 2560 BC (~2,500 yrs earlier); Moon landing ~2,000 yrs later. |
| 14 | `surprising-banana` | true-surprising | Bananas are botanically classified as berries, while strawberries are not. | **supported** | no | Standard botanical definitions; strawberry is an aggregate accessory fruit. |
| 15 | `surprising-wombat` | true-surprising | Wombats produce cube-shaped droppings. | **supported** | no | Documented; 2018 study on intestinal elasticity. |
| 16 | `surprising-sharks` | true-surprising | Sharks have existed for longer than trees. | **supported** | no | Sharks ~450 Mya; earliest trees ~385–390 Mya. |
| 17 | `nitpick-pyramid-date` | nitpick | The Great Pyramid of Giza was built around 2560 BC. | **supported** | no | Conventional date; scholarly ranges (c. 2600–2560 BC) don't make 'around 2560 BC' wrong. |
| 18 | `nitpick-lightspeed` | nitpick | Light travels at about 300,000 kilometres per second. | **supported** | no | 299,792 km/s rounds to 300,000. |
| 19 | `nitpick-everest-round` | nitpick | Mount Everest is roughly 8,850 metres tall. | **supported** | no | 8,848.86 m rounds to about 8,850. |
| 20 | `nitpick-moon-distance` | nitpick | The Moon is about 384,000 km from Earth. | **supported** | no | Average distance ~384,400 km; varies with orbit. |
| 21 | `nitpick-boiling` | nitpick | Water boils at 100 °C at sea level. | **supported** | no | Standard statement; 99.97 °C under ITS-90 is a pedantic distinction. |
| 22 | `nitpick-sunlight` | nitpick | Sunlight takes about 8 minutes to reach Earth. | **supported** | no | About 8 min 20 s on average. |
| 23 | `nitpick-bones` | nitpick | An adult human skeleton has 206 bones. | **supported** | no | Standard count; individual variation (sesamoids etc.) doesn't make it wrong. |
| 24 | `nitpick-ww2` | nitpick | World War II ended in 1945. | **supported** | no | VE Day May 1945, Japan's surrender Aug/Sept 1945. |
| 25 | `num-berlinwall` | numeric-error | The Berlin Wall fell on 9 November 1990. | **refuted** (partially_supported) | **yes** | 9 November 1989. |
| 26 | `num-everest` | nitpick | The official height of Mount Everest, jointly announced by China and Nepal in 2020, is 8,849.86 metres. | **partially_supported** (supported) | no | Announced height is 8,848.86 m. One metre off: technically wrong, but no one is misled. It should not be shown at the default threshold. |
| 27 | `num-lightspeed` | numeric-error | The speed of light in a vacuum is exactly 299,792,458 kilometres per second. | **refuted** (partially_supported) | **yes** | Unit error: 299,792,458 metres per second. |
| 28 | `num-genome` | numeric-error | The human genome contains roughly 3 billion base pairs and about 50,000 protein-coding genes. | **partially_supported** (refuted) | **yes** | ~3.1 billion bp is right; ~19,000–20,000 protein-coding genes. |
| 29 | `num-apollo` | numeric-error | Apollo 11's lunar module landed on 20 July 1969, and Neil Armstrong stepped onto the surface about 30 minutes later. | **partially_supported** (refuted) | **yes** | Landed 20:17 UTC; first step 02:56 UTC on 21 July, about 6.5 hours later. |
| 30 | `num-londonfire` | numeric-error | The Great Fire of London began in September 1667. | **refuted** (partially_supported) | **yes** | 2 September 1666. |
| 31 | `num-eiffel` | numeric-error | The Eiffel Tower is about 450 metres tall including its antennas. | **refuted** (partially_supported) | **yes** | About 330 m including antennas. |
| 32 | `attr-gandhi` | misattribution | Mahatma Gandhi said 'Be the change you wish to see in the world.' | **refuted** (misleading, partially_supported) | **yes** | No record of Gandhi saying this; it paraphrases a longer 1913 passage of his. |
| 33 | `attr-edison` | misattribution | Thomas Edison was granted the first US patent for the telephone in 1876. | **refuted** | **yes** | Alexander Graham Bell, US patent 174,465, March 1876. |
| 34 | `attr-lyell` | misattribution | Continental drift was first proposed by Charles Lyell in 1912. | **refuted** (partially_supported) | **yes** | Alfred Wegener, 1912. (Lyell died in 1875.) |
| 35 | `attr-einstein` | misattribution | Albert Einstein wrote that 'the definition of insanity is doing the same thing over and over and expecting different results.' | **refuted** (misleading) | **yes** | Misattributed; earliest known appearances are from the 1980s (Narcotics Anonymous literature). |
| 36 | `stale-pluto` | outdated | Pluto is the ninth planet of our solar system. | **refuted** (partially_supported, misleading) | **yes** | Reclassified as a dwarf planet by the IAU in 2006. |
| 37 | `stale-willis` | outdated | The world's tallest building is the Willis Tower in Chicago. | **refuted** (partially_supported) | **yes** | Burj Khalifa (since 2010); Willis lost the title in 1998. |
| 38 | `stale-monarch` | outdated | The current monarch of the United Kingdom is Queen Elizabeth II. | **refuted** (partially_supported) | **yes** | Charles III since September 2022. |
| 39 | `stale-http` | outdated | The newest major version of HTTP standardised by the IETF is HTTP/2. | **refuted** (partially_supported) | **yes** | HTTP/3, RFC 9114 (June 2022). |
| 40 | `partial-pyramid` | partly-right | The Great Pyramid of Giza was built around 2560 BC for the pharaoh Khafre. | **partially_supported** (refuted) | **yes** | Date is fine; it was built for Khufu (Khafre built the second pyramid). |
| 41 | `partial-penicillin` | partly-right | Alexander Fleming discovered penicillin in 1938. | **partially_supported** (refuted) | **yes** | Fleming is right; the year was 1928. |
| 42 | `partial-amazon` | partly-right | The Amazon River flows through Peru, Brazil and Argentina. | **partially_supported** (refuted) | **yes** | Peru, Colombia, Brazil. Not Argentina. |
| 43 | `partial-venus` | partly-right | Venus is the hottest planet in the solar system because it is the closest planet to the Sun. | **partially_supported** (refuted, misleading) | **yes** | Hottest: yes. Mercury is closest; Venus is hot because of its CO₂ greenhouse effect. |
| 44 | `myth-greatwall` | myth | The Great Wall of China is visible from the Moon with the naked eye. | **refuted** | **yes** | Not visible from the Moon; barely, if at all, from low Earth orbit. |
| 45 | `myth-brain10` | myth | Humans only use about 10% of their brains. | **refuted** | **yes** | Neuroimaging shows activity across virtually all regions. |
| 46 | `myth-napoleon` | myth | Napoleon Bonaparte was unusually short, around 5 feet 2 inches (157 cm) tall. | **refuted** (misleading, partially_supported) | **yes** | About 5 ft 7 in (~169 cm), average for the time; 5'2" comes from French inches. |
| 47 | `framing-redwine` | framing | Experts agree that moderate red wine consumption is good for heart health. | **misleading** (refuted, partially_supported) | **yes** | No consensus; recent large studies and WHO say no safe level of alcohol. 'Experts agree' overstates. |
| 48 | `framing-sharkcartilage` | framing | Because sharks don't get cancer, shark cartilage is an effective cancer treatment. | **refuted** (misleading) | **yes** | Sharks do get cancer; clinical trials found no benefit. |
| 49 | `framing-lancet` | framing | A 1998 study published in The Lancet found that the MMR vaccine causes autism. | **misleading** (refuted, partially_supported) | **yes** | The Wakefield paper existed but was fraudulent and retracted in 2010; it didn't establish causation, and later studies refute it. |
| 50 | `framing-cra` | framing | The scientific consensus is that the 2008 financial crisis was caused primarily by the Community Reinvestment Act. | **misleading** (refuted) | **yes** | The Financial Crisis Inquiry Commission majority found the CRA was not a significant factor; no such consensus exists. |
| 51 | `unknown-shakespeare` | unverifiable | Shakespeare's personal favourite among his own plays was The Tempest. | **unverifiable** (misleading) | no | No surviving record of his preferences. |
| 52 | `unknown-ninth` | unverifiable | Exactly 1,204 people attended the premiere of Beethoven's Ninth Symphony in 1824. | **unverifiable** | no | No exact attendance record exists. |
| 53 | `unknown-europa` | unverifiable | Microbial life exists in the subsurface ocean of Jupiter's moon Europa. | **unverifiable** (misleading) | no | Unknown; no detection to date. Presenting it as fact could be called misleading. |
| 54 | `recent-pope` | recent | Pope Leo XIV was elected in May 2025. | **supported** | no | Elected 8 May 2025. |
| 55 | `recent-ioc` | recent | Kirsty Coventry was elected president of the International Olympic Committee in 2025, the first woman in the role. | **supported** | no | Elected March 2025, took office June 2025. |
| 56 | `recent-winterolympics` | recent | The 2026 Winter Olympics were held in Oslo, Norway. | **refuted** | **yes** | Milan–Cortina d'Ampezzo, Italy. |
