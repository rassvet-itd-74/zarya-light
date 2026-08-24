// SPDX-License-Identifier: CC0 1.0 Universal
pragma solidity ^0.8.28;

import {EnumerableSet} from "@openzeppelin-contracts-5.4.0-rc.1/utils/structs/EnumerableSet.sol";
import {Strings} from "@openzeppelin-contracts-5.4.0-rc.1/utils/Strings.sol";

import {Regions} from "./Regions.sol";

type PartyOrgan is bytes32;
using {equals as ==, notEquals as !=} for PartyOrgan global;

function equals(PartyOrgan a, PartyOrgan b) pure returns (bool) {
    return PartyOrgan.unwrap(a) == PartyOrgan.unwrap(b);
}

function notEquals(PartyOrgan a, PartyOrgan b) pure returns (bool) {
    return PartyOrgan.unwrap(a) != PartyOrgan.unwrap(b);
}

library PartyOrgans {
    using EnumerableSet for EnumerableSet.AddressSet;
    using Regions for Regions.Region;
    using Strings for uint256;

    PartyOrgan public constant ZERO_PARTY_ORGAN = PartyOrgan.wrap(bytes32(0));

    enum PartyOrganType {
        LocalSoviet,
        LocalGeneralAssembly,
        RegionalSoviet,
        RegionalConference,
        RegionalGeneralAssembly,
        Chairperson,
        CentralSoviet,
        Congress
    }

    struct MembersRegistry {
        mapping(PartyOrgan => EnumerableSet.AddressSet members) membersByOrgan;
    }

    string internal constant CONGRESS_POSTFIX = unicode"СЗД";
    string internal constant SOVIET_POSTFIX = unicode"СОВ";
    string internal constant CHAIRPERSON_POSTFIX = unicode"ПРЛ";
    string internal constant GENERAL_ASSEMBLY_POSTFIX = unicode"ОБС";
    string internal constant CONFERENCE_POSTFIX = unicode"КОН";

    error NotActiveMember(PartyOrgan organ, address caller);
    error InvalidPartyOrganType(PartyOrganType organType);

    function from(PartyOrganType organType, Regions.Region region, uint256 number) internal pure returns (PartyOrgan) {
        string memory identifier = getPartyOrganIdentifier(organType, region, number);
        return PartyOrgan.wrap(keccak256(abi.encodePacked(identifier)));
    }

    function getPartyOrganIdentifier(
        PartyOrganType organType,
        Regions.Region region,
        uint256 number
    )
        internal
        pure
        returns (string memory)
    {
        if (organType == PartyOrganType.LocalSoviet) {
            return string(abi.encodePacked(region.toString(), ".", number.toString(), ".", SOVIET_POSTFIX));
        } else if (organType == PartyOrganType.LocalGeneralAssembly) {
            return string(abi.encodePacked(region.toString(), ".", number.toString(), ".", GENERAL_ASSEMBLY_POSTFIX));
        } else if (organType == PartyOrganType.RegionalSoviet) {
            return string(abi.encodePacked(region.toString(), ".", SOVIET_POSTFIX));
        } else if (organType == PartyOrganType.RegionalConference) {
            return string(abi.encodePacked(region.toString(), ".", CONFERENCE_POSTFIX));
        } else if (organType == PartyOrganType.RegionalGeneralAssembly) {
            return string(abi.encodePacked(region.toString(), ".", GENERAL_ASSEMBLY_POSTFIX));
        } else if (organType == PartyOrganType.Chairperson) {
            return CHAIRPERSON_POSTFIX;
        } else if (organType == PartyOrganType.CentralSoviet) {
            return SOVIET_POSTFIX;
        } else if (organType == PartyOrganType.Congress) {
            return CONGRESS_POSTFIX;
        }
        revert InvalidPartyOrganType(organType);
    }
}
