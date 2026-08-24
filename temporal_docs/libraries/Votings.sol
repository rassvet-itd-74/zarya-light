// SPDX-License-Identifier: CC0 1.0 Universal
pragma solidity ^0.8.28;

import {EnumerableSet} from "@openzeppelin-contracts-5.4.0-rc.1/utils/structs/EnumerableSet.sol";

import {PartyOrgans, PartyOrgan} from "./PartyOrgans.sol";
import {Matricies} from "./Matricies.sol";

library Votings {
    using EnumerableSet for EnumerableSet.AddressSet;
    using Matricies for Matricies.PairOfMatricies;

    enum SuggestionType {
        Membership,
        MembershipRevocation,
        Category,
        Decimals,
        Theme,
        Statement,
        CategoricalValue,
        NumericalValue
    }

    struct MembershipSuggestion {
        address member;
        PartyOrgan organ;
    }

    struct MembershipRevocationSuggestion {
        address member;
        PartyOrgan organ;
    }

    struct CategorySuggestion {
        uint256 x;
        uint256 y;
        uint64 category;
        string categoryName;
        PartyOrgan organ;
    }

    struct DecimalsSuggestion {
        uint256 x;
        uint256 y;
        uint8 decimals;
        PartyOrgan organ;
    }

    struct ThemeSuggestion {
        uint256 x;
        bool isCategorical;
        string theme;
    }

    struct StatementSuggestion {
        uint256 x;
        uint256 y;
        bool isCategorical;
        string statement;
    }

    struct CategoricalValueSuggestion {
        address author;
        uint256 x;
        uint256 y;
        uint64 value;
        PartyOrgan organ;
    }

    struct NumericalValueSuggestion {
        address author;
        uint256 x;
        uint256 y;
        uint64 value;
        PartyOrgan organ;
    }

    struct VoteResults {
        uint256 forVotes;
        uint256 againstVotes;
        uint256 totalVotes;
    }

    struct VotingEligibilityParameters {
        uint256 quorum;
        uint256 approvalPercentage;
        uint256 approvalPercentageBase; // BPS = 10000, % = 100, etc.
    }

    struct Voting {
        uint256 id;
        address author;
        uint256 startTime;
        uint256 endTime;
        uint256 forVotes;
        uint256 againstVotes;
        bool finalized;
        SuggestionType suggestionType;
        MembershipSuggestion memberSuggestionData;
        MembershipRevocationSuggestion memberRevocationSuggestionData;
        CategorySuggestion categorySuggestionData;
        DecimalsSuggestion decimalsSuggestionData;
        ThemeSuggestion themeSuggestionData;
        StatementSuggestion statementSuggestionData;
        CategoricalValueSuggestion categoricalValueSuggestionData;
        NumericalValueSuggestion numericalValueSuggestionData;
        VotingEligibilityParameters eligibilityParameters;
        PartyOrgan governingOrgan;
        mapping(address partyMember => bool) hasVoted;
    }

    error VotingNotActive(uint256 votingId);
    error VotingNotFound(uint256 votingId);
    error UnauthorizedAccess();
    error AlreadyVoted(address partyMember);
    error VotingStillActive(uint256 votingId);
    error VotingAlreadyFinalized(uint256 votingId);
    error InsufficientVotes(uint256 forVotes, uint256 againstVotes);

    event VotingCreated(
        uint256 indexed votingId,
        address indexed author,
        uint256 startTime,
        uint256 endTime,
        SuggestionType suggestionType
    );
    event MembershipVotingCreated(uint256 indexed votingId, PartyOrgan organ, address member);
    event MembershipRevocationVotingCreated(uint256 indexed votingId, PartyOrgan organ, address member);
    event CategoryVotingCreated(
        uint256 indexed votingId, PartyOrgan organ, uint256 x, uint256 y, uint64 category, string categoryName
    );
    event DecimalsVotingCreated(uint256 indexed votingId, PartyOrgan organ, uint256 x, uint256 y, uint8 decimals);
    event ThemeVotingCreated(uint256 indexed votingId, bool isCategorical, uint256 x, string theme);
    event StatementVotingCreated(uint256 indexed votingId, bool isCategorical, uint256 x, uint256 y, string statement);
    event CategoricalValueVotingCreated(
        uint256 indexed votingId, PartyOrgan organ, uint256 x, uint256 y, uint64 value, address author
    );
    event NumericalValueVotingCreated(
        uint256 indexed votingId, PartyOrgan organ, uint256 x, uint256 y, uint64 value, address author
    );
    event VoteCasted(
        uint256 indexed votingId, address indexed partyMember, bool support, uint256 forVotes, uint256 againstVotes
    );
    event VotingFinalized(uint256 indexed votingId, bool success, uint256 forVotes, uint256 againstVotes);

    function isActive(Voting storage self) internal view returns (bool) {
        return block.timestamp >= self.startTime && block.timestamp <= self.endTime;
    }

    function createMembershipVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        PartyOrgan organ,
        address member,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.Membership;
        self.memberSuggestionData = MembershipSuggestion({organ: organ, member: member});
        self.governingOrgan = organ;
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.Membership);
        emit MembershipVotingCreated(id, organ, member);
    }

    function createMembershipRevocationVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        PartyOrgan organ,
        address member,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.MembershipRevocation;
        self.memberRevocationSuggestionData = MembershipRevocationSuggestion({organ: organ, member: member});
        self.governingOrgan = organ;
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.MembershipRevocation);
        emit MembershipRevocationVotingCreated(id, organ, member);
    }

    function createCategoryVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 category,
        string memory categoryName,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.Category;
        self.categorySuggestionData =
            CategorySuggestion({organ: organ, x: x, y: y, category: category, categoryName: categoryName});
        self.governingOrgan = organ;
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.Category);
        emit CategoryVotingCreated(id, organ, x, y, category, categoryName);
    }

    function createDecimalsVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint8 decimals,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.Decimals;
        self.decimalsSuggestionData = DecimalsSuggestion({organ: organ, x: x, y: y, decimals: decimals});
        self.governingOrgan = organ;
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.Decimals);
        emit DecimalsVotingCreated(id, organ, x, y, decimals);
    }

    function createThemeVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        bool isCategorical,
        uint256 x,
        string memory theme,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.Theme;
        self.themeSuggestionData = ThemeSuggestion({isCategorical: isCategorical, x: x, theme: theme});
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.Theme);
        emit ThemeVotingCreated(id, isCategorical, x, theme);
    }

    function createStatementVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        bool isCategorical,
        uint256 x,
        uint256 y,
        string memory statement,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.Statement;
        self.statementSuggestionData =
            StatementSuggestion({isCategorical: isCategorical, x: x, y: y, statement: statement});
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.Statement);
        emit StatementVotingCreated(id, isCategorical, x, y, statement);
    }

    function createCategoricalValueVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 value,
        address valueAuthor,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.CategoricalValue;
        self.categoricalValueSuggestionData =
            CategoricalValueSuggestion({organ: organ, x: x, y: y, value: value, author: valueAuthor});
        self.governingOrgan = organ;
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.CategoricalValue);
        emit CategoricalValueVotingCreated(id, organ, x, y, value, valueAuthor);
    }

    function createNumericalValueVoting(
        Voting storage self,
        uint256 id,
        address author,
        uint256 duration,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 value,
        address valueAuthor,
        uint256 quorum,
        uint256 approvalPercentage,
        uint256 approvalPercentageBase
    )
        internal
    {
        self.id = id;
        self.author = author;
        self.startTime = block.timestamp;
        self.endTime = block.timestamp + duration;
        self.suggestionType = SuggestionType.NumericalValue;
        self.numericalValueSuggestionData =
            NumericalValueSuggestion({organ: organ, x: x, y: y, value: value, author: valueAuthor});
        self.governingOrgan = organ;
        self.eligibilityParameters = VotingEligibilityParameters({
            quorum: quorum, approvalPercentage: approvalPercentage, approvalPercentageBase: approvalPercentageBase
        });

        emit VotingCreated(id, author, self.startTime, self.endTime, SuggestionType.NumericalValue);
        emit NumericalValueVotingCreated(id, organ, x, y, value, valueAuthor);
    }

    // Voting Functions
    function castVote(Voting storage self, bool support, address partyMember) internal {
        if (!isActive(self)) revert VotingNotActive(self.id);
        if (self.hasVoted[partyMember]) revert AlreadyVoted(partyMember);

        self.hasVoted[partyMember] = true;

        if (support) {
            self.forVotes++;
        } else {
            self.againstVotes++;
        }

        emit VoteCasted(self.id, partyMember, support, self.forVotes, self.againstVotes);
    }

    function getVoteResults(Voting storage self) internal view returns (VoteResults memory results) {
        results.forVotes = self.forVotes;
        results.againstVotes = self.againstVotes;
        results.totalVotes = results.forVotes + results.againstVotes;
    }

    function hasPartyMemberVoted(Voting storage self, address partyMember) internal view returns (bool) {
        return self.hasVoted[partyMember];
    }

    function executeVoting(
        Voting storage self,
        Matricies.PairOfMatricies storage matricies,
        PartyOrgans.MembersRegistry storage membersRegistry
    )
        internal
        returns (bool success)
    {
        if (isActive(self)) revert VotingStillActive(self.id);
        if (self.finalized) revert VotingAlreadyFinalized(self.id);

        VoteResults memory results = getVoteResults(self);

        if (results.totalVotes == 0 || results.totalVotes < self.eligibilityParameters.quorum) {
            revert InsufficientVotes(results.forVotes, results.againstVotes);
        }

        uint256 approvalPercentage =
            (results.forVotes * self.eligibilityParameters.approvalPercentageBase) / results.totalVotes;
        success = approvalPercentage > self.eligibilityParameters.approvalPercentage;

        // If successful, execute the suggestion by modifying the matrices
        if (success) {
            _executeApprovedSuggestion(self, membersRegistry, matricies);
        }

        self.finalized = true;

        emit VotingFinalized(self.id, success, results.forVotes, results.againstVotes);
    }

    function _executeApprovedSuggestion(
        Voting storage self,
        PartyOrgans.MembersRegistry storage membersRegistry,
        Matricies.PairOfMatricies storage matricies
    )
        private
    {
        if (self.suggestionType == SuggestionType.Membership) {
            MembershipSuggestion memory suggestion = self.memberSuggestionData;
            membersRegistry.membersByOrgan[suggestion.organ].add(suggestion.member);
        } else if (self.suggestionType == SuggestionType.MembershipRevocation) {
            MembershipRevocationSuggestion memory suggestion = self.memberRevocationSuggestionData;
            membersRegistry.membersByOrgan[suggestion.organ].remove(suggestion.member);
        } else if (self.suggestionType == SuggestionType.Category) {
            CategorySuggestion memory suggestion = self.categorySuggestionData;
            matricies.addCategory(
                suggestion.organ, suggestion.x, suggestion.y, suggestion.category, suggestion.categoryName
            );
        } else if (self.suggestionType == SuggestionType.Decimals) {
            DecimalsSuggestion memory suggestion = self.decimalsSuggestionData;
            matricies.setDecimals(suggestion.organ, suggestion.x, suggestion.y, suggestion.decimals);
        } else if (self.suggestionType == SuggestionType.Theme) {
            ThemeSuggestion memory suggestion = self.themeSuggestionData;
            matricies.setTheme(suggestion.isCategorical, suggestion.x, suggestion.theme);
        } else if (self.suggestionType == SuggestionType.Statement) {
            StatementSuggestion memory suggestion = self.statementSuggestionData;
            matricies.setStatement(suggestion.isCategorical, suggestion.x, suggestion.y, suggestion.statement);
        } else if (self.suggestionType == SuggestionType.CategoricalValue) {
            CategoricalValueSuggestion memory suggestion = self.categoricalValueSuggestionData;
            matricies.addValue(
                suggestion.organ,
                suggestion.x,
                suggestion.y,
                suggestion.value,
                suggestion.author,
                true // isCategorical
            );
        } else if (self.suggestionType == SuggestionType.NumericalValue) {
            NumericalValueSuggestion memory suggestion = self.numericalValueSuggestionData;
            matricies.addValue(
                suggestion.organ,
                suggestion.x,
                suggestion.y,
                suggestion.value,
                suggestion.author,
                false // isCategorical
            );
        }
    }

    function isFinalized(Voting storage self) internal view returns (bool) {
        return self.finalized;
    }
}
