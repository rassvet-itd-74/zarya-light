// SPDX-License-Identifier: CC0 1.0 Universal
pragma solidity ^0.8.28;

library Regions {
    // https://www.consultant.ru/document/cons_doc_LAW_287480/8f29ebe5f8d588f758502bc41ff2da96a45fc497/
    enum Region {
        FEDERAL, // = 00,
        ADYGEA_REPUBLIC, // = 01,
        BASHKORTOSTAN_REPUBLIC, // = 02,
        BURYATIA_REPUBLIC, // = 03,
        ALTAY_REPUBLIC, // = 04,
        DAGHESTAN_REPUBLIC, // = 05,
        INGUSHETIA_REPUBLIC, // = 06,
        KABARDINO_BALKAR_REPUBLIC, // = 07,
        KALMYKIYA_REPUBLIC, // = 08,
        KARACHAY_CHERKESS_REPUBLIC, // = 09,
        KARELIA_REPUBLIC, // = 10,
        KOMI_REPUBLIC, // = 11,
        MARIY_EL_REPUBLIC, // = 12,
        MORDOVIA_REPUBLIC, // = 13,
        SAKHA_REPUBLIC_YAKUTIA, // = 14,
        NORTH_OSSETIA_ALANIA_REPUBLIC, // = 15,
        TATARSTAN_REPUBLIC, // = 16,
        TYVA_REPUBLIC, // = 17,
        UDMURTIA_REPUBLIC, // = 18,
        HAKASSIA_REPUBLIC, // = 19,
        CHECHEN_REPUBLIC, // = 95,
        CHUVASHIA_REPUBLIC, // = 21,
        KRYM_REPUBLIC, // = 82,
        ALTAYSKY_KRAI, // = 22,
        PERMSKY_KRAI, // = 59,
        PRIMORSKY_KRAI, // = 25,
        STAVROPOL_KRAI, // = 26,
        HABAROVSKY_KRAI, // = 27,
        AMURSKAYA_OBLAST, // = 28,
        ARCHANGELSKAYA_OBLAST, // = 29,
        ASTRAKHANSKAYA_OBLAST, // = 30,
        BELGORODSKAYA_OBLAST, // = 31,
        BRYANSKAYA_OBLAST, // = 32,
        VLADIMIRSKAYA_OBLAST, // = 33,
        VOLGOGRADSKAYA_OBLAST, // = 34,
        VOLOGODSKAYA_OBLAST, // = 35,
        VORONEZHSKAYA_OBLAST, // = 36,
        IVANOVSKAYA_OBLAST, // = 37,
        IRKUTSKAYA_OBLAST, // = 38,
        KALININGRADSKAYA_OBLAST, // = 39,
        KALUZHSKAYA_OBLAST, // = 40,
        KEMEROVSKAYA_OBLAST, // = 42,
        KIROVSKAYA_OBLAST, // = 43,
        KOSTROMSKAYA_OBLAST, // = 44,
        KURGANSKAYA_OBLAST, // = 45,
        KURSKAYA_OBLAST, // = 46,
        LENINGRADSKAYA_OBLAST, // = 47,
        LIPETSKAYA_OBLAST, // = 48,
        MAGADANSKAYA_OBLAST, // = 49,
        MOSKOVSKAYA_OBLAST_50, // = 50,
        MOSKOVSKAYA_OBLAST_90, // = 90,
        MURMANSKAYA_OBLAST, // = 51,
        ZABAIKALSKY_KRAI, // = 75,
        KAMCHATKSKY_KRAI, // = 41,
        KRASNODARSKY_KRAI_23, // = 23,
        KRASNODARSKY_KRAI_93, // = 93,
        KRASNOYARSKY_KRAI, // = 24,
        ORLOVSKAYA_OBLAST, // = 57,
        PENZENSKAYA_OBLAST, // = 58,
        PSKOVSKAYA_OBLAST, // = 60,
        ROSTOVSKAYA_OBLAST, // = 61,
        RYAZANSKAYA_OBLAST, // = 62,
        SAMARSKAYA_OBLAST, // = 63,
        SARATOVSKAYA_OBLAST, // = 64,
        SAKHALINSKAYA_OBLAST, // = 65,
        SVERDLOVSKAYA_OBLAST_66, // = 66,
        SVERDLOVSKAYA_OBLAST_96, // = 96,
        SMOLENSKAYA_OBLAST, // = 67,
        TAMBOVSKAYA_OBLAST, // = 68,
        TVERSKAYA_OBLAST, // = 69,
        TOMSKAYA_OBLAST, // = 70,
        TULSKAYA_OBLAST, // = 71,
        TUMENSKAYA_OBLAST, // = 72,
        ULYANOVSKAYA_OBLAST, // = 73,
        CHELYABINSKAYA_OBLAST, // = 74,
        YAROSLAVSKAYA_OBLAST, // = 76,
        NIZHEGORODSKAYA_OBLAST, // = 52,
        NOVGORODSKAYA_OBLAST, // = 53,
        NOVOSIBIRSKAYA_OBLAST, // = 54,
        OMSKAYA_OBLAST, // = 55,
        ORENBURGSKAYA_OBLAST, // = 56,
        MOSCOW_77, // = 77,
        MOSCOW_97, // = 97,
        MOSCOW_99, // = 99,
        SAINT_PETERSBURG_78, // = 78,
        SAINT_PETERSBURG_98, // = 98,
        SEVASTOPOL, // = 92,
        EVREYSKAYA_AUTONOMNAYA_OBLAST, // = 79,
        NENETSKY_AUTONOMNY_OKRUG, // = 83,
        HANTY_MANSIYSKY_AUTONOMNY_OKRUG_YUGRA, // = 86,
        CHUKOTKSKY_AUTONOMNY_OKRUG, // = 87,
        YAMALO_NENETSKY_AUTONOMNY_OKRUG, // = 89,
        EXTERNAL_LANDS_88, // = 88,
        EXTERNAL_LANDS_94, // = 94,
        // The following regions de jure are a part of the Russian Federation and are included for completeness.
        // The team and the project do not recognize the annexation of these territories.
        DONETSK_PEOPLES_REPUBLIC, // = 80,
        LUGANSK_PEOPLES_REPUBLIC, // = 81,
        HERSONSKAYA_OBLAST, // = 84,
        ZAPOROZHSKAYA_OBLAST // = 85
    }

    error UnknownRegion(Region region);

    function toString(Region region) internal pure returns (string memory) {
        if (region == Region.FEDERAL) return "00";
        if (region == Region.ADYGEA_REPUBLIC) return "01";
        if (region == Region.BASHKORTOSTAN_REPUBLIC) return "02";
        if (region == Region.BURYATIA_REPUBLIC) return "03";
        if (region == Region.ALTAY_REPUBLIC) return "04";
        if (region == Region.DAGHESTAN_REPUBLIC) return "05";
        if (region == Region.INGUSHETIA_REPUBLIC) return "06";
        if (region == Region.KABARDINO_BALKAR_REPUBLIC) return "07";
        if (region == Region.KALMYKIYA_REPUBLIC) return "08";
        if (region == Region.KARACHAY_CHERKESS_REPUBLIC) return "09";
        if (region == Region.KARELIA_REPUBLIC) return "10";
        if (region == Region.KOMI_REPUBLIC) return "11";
        if (region == Region.MARIY_EL_REPUBLIC) return "12";
        if (region == Region.MORDOVIA_REPUBLIC) return "13";
        if (region == Region.SAKHA_REPUBLIC_YAKUTIA) return "14";
        if (region == Region.NORTH_OSSETIA_ALANIA_REPUBLIC) return "15";
        if (region == Region.TATARSTAN_REPUBLIC) return "16";
        if (region == Region.TYVA_REPUBLIC) return "17";
        if (region == Region.UDMURTIA_REPUBLIC) return "18";
        if (region == Region.HAKASSIA_REPUBLIC) return "19";
        if (region == Region.CHECHEN_REPUBLIC) return "95";
        if (region == Region.CHUVASHIA_REPUBLIC) return "21";
        if (region == Region.KRYM_REPUBLIC) return "82";
        if (region == Region.ALTAYSKY_KRAI) return "22";
        if (region == Region.PERMSKY_KRAI) return "59";
        if (region == Region.PRIMORSKY_KRAI) return "25";
        if (region == Region.STAVROPOL_KRAI) return "26";
        if (region == Region.HABAROVSKY_KRAI) return "27";
        if (region == Region.AMURSKAYA_OBLAST) return "28";
        if (region == Region.ARCHANGELSKAYA_OBLAST) return "29";
        if (region == Region.ASTRAKHANSKAYA_OBLAST) return "30";
        if (region == Region.BELGORODSKAYA_OBLAST) return "31";
        if (region == Region.BRYANSKAYA_OBLAST) return "32";
        if (region == Region.VLADIMIRSKAYA_OBLAST) return "33";
        if (region == Region.VOLGOGRADSKAYA_OBLAST) return "34";
        if (region == Region.VOLOGODSKAYA_OBLAST) return "35";
        if (region == Region.VORONEZHSKAYA_OBLAST) return "36";
        if (region == Region.IVANOVSKAYA_OBLAST) return "37";
        if (region == Region.IRKUTSKAYA_OBLAST) return "38";
        if (region == Region.KALININGRADSKAYA_OBLAST) return "39";
        if (region == Region.KALUZHSKAYA_OBLAST) return "40";
        if (region == Region.KEMEROVSKAYA_OBLAST) return "42";
        if (region == Region.KIROVSKAYA_OBLAST) return "43";
        if (region == Region.KOSTROMSKAYA_OBLAST) return "44";
        if (region == Region.KURGANSKAYA_OBLAST) return "45";
        if (region == Region.KURSKAYA_OBLAST) return "46";
        if (region == Region.LENINGRADSKAYA_OBLAST) return "47";
        if (region == Region.LIPETSKAYA_OBLAST) return "48";
        if (region == Region.MAGADANSKAYA_OBLAST) return "49";
        if (region == Region.MOSKOVSKAYA_OBLAST_50) return "50";
        if (region == Region.MOSKOVSKAYA_OBLAST_90) return "90";
        if (region == Region.MURMANSKAYA_OBLAST) return "51";
        if (region == Region.ZABAIKALSKY_KRAI) return "75";
        if (region == Region.KAMCHATKSKY_KRAI) return "41";
        if (region == Region.KRASNODARSKY_KRAI_23) return "23";
        if (region == Region.KRASNODARSKY_KRAI_93) return "93";
        if (region == Region.KRASNOYARSKY_KRAI) return "24";
        if (region == Region.ORLOVSKAYA_OBLAST) return "57";
        if (region == Region.PENZENSKAYA_OBLAST) return "58";
        if (region == Region.PSKOVSKAYA_OBLAST) return "60";
        if (region == Region.ROSTOVSKAYA_OBLAST) return "61";
        if (region == Region.RYAZANSKAYA_OBLAST) return "62";
        if (region == Region.SAMARSKAYA_OBLAST) return "63";
        if (region == Region.SARATOVSKAYA_OBLAST) return "64";
        if (region == Region.SAKHALINSKAYA_OBLAST) return "65";
        if (region == Region.SVERDLOVSKAYA_OBLAST_66) return "66";
        if (region == Region.SVERDLOVSKAYA_OBLAST_96) return "96";
        if (region == Region.SMOLENSKAYA_OBLAST) return "67";
        if (region == Region.TAMBOVSKAYA_OBLAST) return "68";
        if (region == Region.TVERSKAYA_OBLAST) return "69";
        if (region == Region.TOMSKAYA_OBLAST) return "70";
        if (region == Region.TULSKAYA_OBLAST) return "71";
        if (region == Region.TUMENSKAYA_OBLAST) return "72";
        if (region == Region.ULYANOVSKAYA_OBLAST) return "73";
        if (region == Region.CHELYABINSKAYA_OBLAST) return "74";
        if (region == Region.YAROSLAVSKAYA_OBLAST) return "76";
        if (region == Region.NIZHEGORODSKAYA_OBLAST) return "52";
        if (region == Region.NOVGORODSKAYA_OBLAST) return "53";
        if (region == Region.NOVOSIBIRSKAYA_OBLAST) return "54";
        if (region == Region.OMSKAYA_OBLAST) return "55";
        if (region == Region.ORENBURGSKAYA_OBLAST) return "56";
        if (region == Region.MOSCOW_77) return "77";
        if (region == Region.MOSCOW_97) return "97";
        if (region == Region.MOSCOW_99) return "99";
        if (region == Region.SAINT_PETERSBURG_78) return "78";
        if (region == Region.SAINT_PETERSBURG_98) return "98";
        if (region == Region.SEVASTOPOL) return "92";
        if (region == Region.EVREYSKAYA_AUTONOMNAYA_OBLAST) return "79";
        if (region == Region.NENETSKY_AUTONOMNY_OKRUG) return "83";
        if (region == Region.HANTY_MANSIYSKY_AUTONOMNY_OKRUG_YUGRA) return "86";
        if (region == Region.CHUKOTKSKY_AUTONOMNY_OKRUG) return "87";
        if (region == Region.YAMALO_NENETSKY_AUTONOMNY_OKRUG) return "89";
        if (region == Region.EXTERNAL_LANDS_88) return "88";
        if (region == Region.EXTERNAL_LANDS_94) return "94";

        // The following regions de jure are a part of the Russian Federation and are included for completeness.
        if (region == Region.DONETSK_PEOPLES_REPUBLIC) return "80";
        if (region == Region.LUGANSK_PEOPLES_REPUBLIC) return "81";
        if (region == Region.HERSONSKAYA_OBLAST) return "84";
        if (region == Region.ZAPOROZHSKAYA_OBLAST) return "85";
        revert UnknownRegion(region);
    }
}
