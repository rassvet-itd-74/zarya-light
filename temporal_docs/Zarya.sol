// SPDX-License-Identifier: CC0 1.0 Universal
pragma solidity ^0.8.28;

import {EnumerableSet} from "@openzeppelin-contracts-5.4.0-rc.1/utils/structs/EnumerableSet.sol";

import {Regions} from "./libraries/Regions.sol";
import {PartyOrgans, PartyOrgan} from "./libraries/PartyOrgans.sol";
import {Matricies} from "./libraries/Matricies.sol";
import {Votings} from "./libraries/Votings.sol";

contract Zarya {
    using Regions for Regions.Region;
    using EnumerableSet for EnumerableSet.AddressSet;
    using Votings for Votings.Voting;
    using Matricies for Matricies.PairOfMatricies;

    uint256 public nextVotingId;

    bool private _organsInitialized;

    mapping(uint256 => Votings.Voting) internal _votings;
    mapping(PartyOrgan => Votings.VotingEligibilityParameters) internal _votingEligibilityParametersByOrgan;

    PartyOrgans.MembersRegistry internal _partyMembersRegistry;
    Matricies.PairOfMatricies internal _matricies;

    Votings.VotingEligibilityParameters public simpleMajority =
        Votings.VotingEligibilityParameters({quorum: 1, approvalPercentage: 5000, approvalPercentageBase: 10_000});

    error OrgansAlreadyInitialized();
    error InvalidMemberAddress();
    error EmptyInitializationData();
    error CannotRemoveChairman(PartyOrgan organ, address member);
    error NotChairman(address caller);

    modifier onlyMember(PartyOrgan organ) {
        _onlyMember(organ);
        _;
    }

    modifier onlyChairman() {
        _onlyChairman();
        _;
    }

    modifier votingExists(uint256 votingId) {
        _votingExists(votingId);
        _;
    }

    constructor(address _chairman) {
        if (_chairman == address(0)) revert InvalidMemberAddress();
        PartyOrgan chairperson = PartyOrgans.from(PartyOrgans.PartyOrganType.Chairperson, Regions.Region.FEDERAL, 0);
        _partyMembersRegistry.membersByOrgan[chairperson].add(_chairman);
    }

    function initializeOrgans(PartyOrgan[] calldata organs, address[] calldata members) external onlyChairman {
        if (_organsInitialized) revert OrgansAlreadyInitialized();
        if (organs.length == 0 || organs.length != members.length) revert EmptyInitializationData();
        _organsInitialized = true;
        for (uint256 i = 0; i < organs.length; i++) {
            if (members[i] == address(0)) revert InvalidMemberAddress();
            _partyMembersRegistry.membersByOrgan[organs[i]].add(members[i]);
        }
    }

    function createMembershipVoting(
        PartyOrgan organ,
        address member,
        uint256 duration
    )
        external
        returns (uint256 votingId)
    {
        _onlyMemberOrChairman(organ);
        votingId = _getNextVotingId();
        Votings.VotingEligibilityParameters memory params = _getEligibilityParams(organ);
        _votings[votingId].createMembershipVoting(
            votingId,
            msg.sender,
            duration,
            organ,
            member,
            params.quorum,
            params.approvalPercentage,
            params.approvalPercentageBase
        );
    }

    function createMembershipRevocationVoting(
        PartyOrgan organ,
        address member,
        uint256 duration
    )
        external
        returns (uint256 votingId)
    {
        _onlyMemberOrChairman(organ);
        if (_isChairman(member)) revert CannotRemoveChairman(organ, member);
        votingId = _getNextVotingId();
        Votings.VotingEligibilityParameters memory params = _getEligibilityParams(organ);
        _votings[votingId].createMembershipRevocationVoting(
            votingId,
            msg.sender,
            duration,
            organ,
            member,
            params.quorum,
            params.approvalPercentage,
            params.approvalPercentageBase
        );
    }

    function createCategoryVoting(
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 category,
        string calldata categoryName,
        uint256 duration
    )
        external
        onlyMember(organ)
        returns (uint256 votingId)
    {
        votingId = _getNextVotingId();
        Votings.VotingEligibilityParameters memory params = _getEligibilityParams(organ);
        _votings[votingId].createCategoryVoting(
            votingId,
            msg.sender,
            duration,
            organ,
            x,
            y,
            category,
            categoryName,
            params.quorum,
            params.approvalPercentage,
            params.approvalPercentageBase
        );
    }

    function createDecimalsVoting(
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint8 decimals,
        uint256 duration
    )
        external
        onlyMember(organ)
        returns (uint256 votingId)
    {
        votingId = _getNextVotingId();
        Votings.VotingEligibilityParameters memory params = _getEligibilityParams(organ);
        _votings[votingId].createDecimalsVoting(
            votingId,
            msg.sender,
            duration,
            organ,
            x,
            y,
            decimals,
            params.quorum,
            params.approvalPercentage,
            params.approvalPercentageBase
        );
    }

    function createThemeVoting(
        bool isCategorical,
        uint256 x,
        string calldata theme,
        uint256 duration
    )
        external
        returns (uint256 votingId)
    {
        votingId = _getNextVotingId();
        _votings[votingId].createThemeVoting(
            votingId,
            msg.sender,
            duration,
            isCategorical,
            x,
            theme,
            simpleMajority.quorum,
            simpleMajority.approvalPercentage,
            simpleMajority.approvalPercentageBase
        );
    }

    function createStatementVoting(
        bool isCategorical,
        uint256 x,
        uint256 y,
        string calldata statement,
        uint256 duration
    )
        external
        returns (uint256 votingId)
    {
        votingId = _getNextVotingId();
        _votings[votingId].createStatementVoting(
            votingId,
            msg.sender,
            duration,
            isCategorical,
            x,
            y,
            statement,
            simpleMajority.quorum,
            simpleMajority.approvalPercentage,
            simpleMajority.approvalPercentageBase
        );
    }

    function createCategoricalValueVoting(
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 value,
        address valueAuthor,
        uint256 duration
    )
        external
        onlyMember(organ)
        returns (uint256 votingId)
    {
        Votings.VotingEligibilityParameters memory params = _getEligibilityParams(organ);
        return _createValueVoting(
            true,
            organ,
            x,
            y,
            value,
            valueAuthor,
            duration,
            params.quorum,
            params.approvalPercentage,
            params.approvalPercentageBase
        );
    }

    function createNumericalValueVoting(
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 value,
        address valueAuthor,
        uint256 duration
    )
        external
        onlyMember(organ)
        returns (uint256 votingId)
    {
        Votings.VotingEligibilityParameters memory params = _getEligibilityParams(organ);
        return _createValueVoting(
            false,
            organ,
            x,
            y,
            value,
            valueAuthor,
            duration,
            params.quorum,
            params.approvalPercentage,
            params.approvalPercentageBase
        );
    }

    function castVote(uint256 votingId, bool support) external votingExists(votingId) {
        PartyOrgan governingOrgan = _votings[votingId].governingOrgan;
        if (governingOrgan != PartyOrgans.ZERO_PARTY_ORGAN) {
            _onlyMemberOrChairman(governingOrgan);
        }
        _votings[votingId].castVote(support, msg.sender);
    }

    function setMinimumQuorum(PartyOrgan organ, uint256 value) external onlyChairman {
        _votingEligibilityParametersByOrgan[organ].quorum = value;
    }

    function setMinimumApprovalPercentage(PartyOrgan organ, uint256 value) external onlyChairman {
        _votingEligibilityParametersByOrgan[organ].approvalPercentage = value;
    }

    function setMinimumApprovalPercentageBase(PartyOrgan organ, uint256 value) external onlyChairman {
        _votingEligibilityParametersByOrgan[organ].approvalPercentageBase = value;
    }

    function executeVoting(uint256 votingId) external votingExists(votingId) returns (bool success) {
        return _votings[votingId].executeVoting(_matricies, _partyMembersRegistry);
    }

    function transferChairmanship(address newChairman) external onlyChairman {
        if (newChairman == address(0)) revert InvalidMemberAddress();
        PartyOrgan chairperson = PartyOrgans.from(PartyOrgans.PartyOrganType.Chairperson, Regions.Region.FEDERAL, 0);
        _partyMembersRegistry.membersByOrgan[chairperson].remove(msg.sender);
        _partyMembersRegistry.membersByOrgan[chairperson].add(newChairman);
    }

    function getVotingResults(uint256 votingId)
        external
        view
        votingExists(votingId)
        returns (Votings.VoteResults memory)
    {
        return _votings[votingId].getVoteResults();
    }

    function hasVoted(uint256 votingId, address member) external view votingExists(votingId) returns (bool) {
        return _votings[votingId].hasPartyMemberVoted(member);
    }

    function isVotingActive(uint256 votingId) external view votingExists(votingId) returns (bool) {
        return _votings[votingId].isActive();
    }

    function isVotingFinalized(uint256 votingId) external view votingExists(votingId) returns (bool) {
        return _votings[votingId].isFinalized();
    }

    function isMember(PartyOrgan organ, address member) external view returns (bool) {
        return _partyMembersRegistry.membersByOrgan[organ].contains(member);
    }

    function getTheme(bool isCategorical, uint256 x) external view returns (string memory) {
        return _matricies.getTheme(isCategorical, x);
    }

    function getStatement(bool isCategorical, uint256 y) external view returns (string memory) {
        return _matricies.getStatement(isCategorical, y);
    }

    function getCategoricalCellOrgan(uint256 x, uint256 y) external view returns (PartyOrgan) {
        return _matricies.getCategoricalCellOrgan(x, y);
    }

    function getNumericalCellOrgan(uint256 x, uint256 y) external view returns (PartyOrgan) {
        return _matricies.getNumericalCellOrgan(x, y);
    }

    function getAllowedCategories(uint256 x, uint256 y) external view returns (uint64[] memory) {
        return _matricies.getAllowedCategories(x, y);
    }

    function getCategoryName(uint256 x, uint256 y, uint64 category) external view returns (string memory) {
        return _matricies.getCategoryName(x, y, category);
    }

    function isCategoryAllowed(uint256 x, uint256 y, uint64 category) external view returns (bool) {
        return _matricies.isCategoryAllowed(x, y, category);
    }

    function getCategoricalSampleLength(uint256 x, uint256 y) external view returns (uint256) {
        return _matricies.getCategoricalSampleLength(x, y);
    }

    function getNumericalSampleLength(uint256 x, uint256 y) external view returns (uint256) {
        return _matricies.getNumericalSampleLength(x, y);
    }

    function getCategoricalCellInfo(
        uint256 x,
        uint256 y
    )
        external
        view
        returns (PartyOrgan organ, uint64[] memory allowedCategories, uint256 sampleLength)
    {
        return _matricies.getCategoricalCellInfo(x, y);
    }

    function getNumericalCellInfo(
        uint256 x,
        uint256 y
    )
        external
        view
        returns (PartyOrgan organ, uint8 decimals, uint256 sampleLength)
    {
        return _matricies.getNumericalCellInfo(x, y);
    }

    function getCategoricalLatestValue(uint256 x, uint256 y)
        external
        view
        returns (Matricies.DecodedCheckpoint memory)
    {
        return _matricies.getLatestCategoricalValue(x, y);
    }

    function getNumericalLatestValue(uint256 x, uint256 y) external view returns (Matricies.DecodedCheckpoint memory) {
        return _matricies.getLatestNumericalValue(x, y);
    }

    function getCategoricalValueAt(
        uint256 x,
        uint256 y,
        uint32 index
    )
        external
        view
        returns (Matricies.DecodedCheckpoint memory)
    {
        return _matricies.getCategoricalValueAt(x, y, index);
    }

    function getNumericalValueAt(
        uint256 x,
        uint256 y,
        uint32 index
    )
        external
        view
        returns (Matricies.DecodedCheckpoint memory)
    {
        return _matricies.getNumericalValueAt(x, y, index);
    }

    function getCategoricalValueAtTimestamp(
        uint256 x,
        uint256 y,
        uint32 timestamp
    )
        external
        view
        returns (Matricies.DecodedCheckpoint memory)
    {
        return _matricies.getCategoricalValueAtTimestamp(x, y, timestamp);
    }

    function getNumericalValueAtTimestamp(
        uint256 x,
        uint256 y,
        uint32 timestamp
    )
        external
        view
        returns (Matricies.DecodedCheckpoint memory)
    {
        return _matricies.getNumericalValueAtTimestamp(x, y, timestamp);
    }

    function getCategoricalHistory(
        uint256 x,
        uint256 y,
        uint32 offset,
        uint256 limit
    )
        external
        view
        returns (uint32[] memory timestamps, address[] memory authors, uint64[] memory values)
    {
        return _matricies.getCategoricalHistory(x, y, offset, limit);
    }

    function getNumericalHistory(
        uint256 x,
        uint256 y,
        uint32 offset,
        uint256 limit
    )
        external
        view
        returns (uint32[] memory timestamps, address[] memory authors, uint64[] memory values)
    {
        return _matricies.getNumericalHistory(x, y, offset, limit);
    }

    function getPartyOrgan(
        PartyOrgans.PartyOrganType organType,
        Regions.Region region,
        uint256 number
    )
        external
        pure
        returns (PartyOrgan)
    {
        return PartyOrgans.from(organType, region, number);
    }

    function getPartyOrganIdentifier(
        PartyOrgans.PartyOrganType organType,
        Regions.Region region,
        uint256 number
    )
        external
        pure
        returns (string memory)
    {
        return PartyOrgans.getPartyOrganIdentifier(organType, region, number);
    }

    function _getEligibilityParams(PartyOrgan organ)
        internal
        view
        returns (Votings.VotingEligibilityParameters memory)
    {
        Votings.VotingEligibilityParameters storage params = _votingEligibilityParametersByOrgan[organ];
        if (params.approvalPercentageBase == 0) return simpleMajority;
        return params;
    }

    function _getNextVotingId() internal returns (uint256) {
        unchecked {
            return ++nextVotingId;
        }
    }

    function _createValueVoting(
        bool isCategorical,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 value,
        address valueAuthor,
        uint256 duration,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
        returns (uint256 votingId)
    {
        votingId = _getNextVotingId();
        if (isCategorical) {
            _votings[votingId].createCategoricalValueVoting(
                votingId,
                msg.sender,
                duration,
                organ,
                x,
                y,
                value,
                valueAuthor,
                quorum,
                approvalPercentage,
                approvalPercentageBase
            );
        } else {
            _votings[votingId].createNumericalValueVoting(
                votingId,
                msg.sender,
                duration,
                organ,
                x,
                y,
                value,
                valueAuthor,
                quorum,
                approvalPercentage,
                approvalPercentageBase
            );
        }
    }

    function _onlyMember(PartyOrgan organ) internal view {
        if (!_partyMembersRegistry.membersByOrgan[organ].contains(msg.sender)) {
            revert PartyOrgans.NotActiveMember(organ, msg.sender);
        }
    }

    function _votingExists(uint256 votingId) internal view {
        if (votingId == 0 || votingId > nextVotingId) revert Votings.VotingNotFound(votingId);
    }

    function _onlyMemberOrChairman(PartyOrgan organ) internal view {
        if (!_partyMembersRegistry.membersByOrgan[organ].contains(msg.sender)) {
            PartyOrgan chairperson = PartyOrgans.from(PartyOrgans.PartyOrganType.Chairperson, Regions.Region.FEDERAL, 0);
            if (!_partyMembersRegistry.membersByOrgan[chairperson].contains(msg.sender)) {
                revert PartyOrgans.NotActiveMember(organ, msg.sender);
            }
        }
    }

    function _onlyChairman() internal view {
        if (!_isChairman(msg.sender)) revert NotChairman(msg.sender);
    }

    function _isChairman(address member) internal view returns (bool) {
        PartyOrgan chairperson = PartyOrgans.from(PartyOrgans.PartyOrganType.Chairperson, Regions.Region.FEDERAL, 0);
        return _partyMembersRegistry.membersByOrgan[chairperson].contains(member);
    }
}
