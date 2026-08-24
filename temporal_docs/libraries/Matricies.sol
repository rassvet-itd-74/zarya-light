// SPDX-License-Identifier: CC0 1.0 Universal
pragma solidity ^0.8.28;

import {Checkpoints} from "@openzeppelin-contracts-5.4.0-rc.1/utils/structs/Checkpoints.sol";
import {EnumerableSet} from "@openzeppelin-contracts-5.4.0-rc.1/utils/structs/EnumerableSet.sol";

import {PartyOrgans, PartyOrgan} from "./PartyOrgans.sol";

library Matricies {
    using Checkpoints for Checkpoints.Trace224;
    using EnumerableSet for EnumerableSet.UintSet;

    struct DecodedCheckpoint {
        uint32 timestamp;
        address author;
        uint64 value;
    }

    struct CategoricalCell {
        PartyOrgan organ;
        Checkpoints.Trace224 categoricalSample;
        EnumerableSet.UintSet allowedCategories;
        mapping(uint64 category => string name) categoryNames;
    }

    struct NumericalCell {
        PartyOrgan organ;
        Checkpoints.Trace224 numericalSample;
        uint8 decimals;
    }

    struct PairOfMatricies {
        mapping(bool isCategorical => mapping(uint256 x => string theme)) themes;
        mapping(bool isCategorical => mapping(uint256 y => string statement)) statements;
        mapping(uint256 x => mapping(uint256 y => CategoricalCell)) categoricalMatrix;
        mapping(uint256 x => mapping(uint256 y => NumericalCell)) numericalMatrix;
    }

    error InvalidOrgan(PartyOrgan organ);
    error NoStatementSet(bool isCategorical, uint256 y);
    error NoThemeSet(bool isCategorical, uint256 x);
    error CategoryAlreadyExists(uint64 category);
    error InvalidCategory(uint64 category);

    event ValueAdded(uint256 indexed x, uint256 indexed y, uint64 value, address indexed author);
    event CategoryAdded(uint256 indexed x, uint256 indexed y, uint64 category);

    function isCategoryAllowed(
        PairOfMatricies storage self,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 category
    )
        internal
        view
        returns (bool)
    {
        return self.categoricalMatrix[x][y].allowedCategories.contains(category)
            && self.categoricalMatrix[x][y].organ == organ;
    }

    function _decodeCheckpoint(uint32 timestamp, uint224 encodedValue)
        internal
        pure
        returns (DecodedCheckpoint memory)
    {
        // casting to 'uint160' is safe because encodedValue stores address in upper 160 bits (bits 64-223)
        // forge-lint: disable-next-line(unsafe-typecast)
        address author = address(uint160(encodedValue >> 64));
        // casting to 'uint64' is safe because encodedValue stores value in lower 64 bits (bits 0-63)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 value = uint64(encodedValue);
        return DecodedCheckpoint({timestamp: timestamp, author: author, value: value});
    }

    function addValue(
        PairOfMatricies storage self,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 value,
        address author,
        bool isCategorical
    )
        external
    {
        if (bytes(self.themes[isCategorical][x]).length == 0) {
            revert NoThemeSet(isCategorical, x);
        }
        if (bytes(self.statements[isCategorical][y]).length == 0) {
            revert NoStatementSet(isCategorical, y);
        }
        if (isCategorical) {
            if (!isCategoryAllowed(self, organ, x, y, value)) {
                revert InvalidCategory(value);
            }
            if (
                self.categoricalMatrix[x][y].organ != PartyOrgans.ZERO_PARTY_ORGAN
                    && self.categoricalMatrix[x][y].organ != organ
            ) {
                revert InvalidOrgan(organ);
            }
            self.categoricalMatrix[x][y].organ = organ;
            self.categoricalMatrix[x][y].categoricalSample
                .push(uint32(block.timestamp), uint224(bytes28(abi.encodePacked(author, value))));
        } else {
            if (
                self.numericalMatrix[x][y].organ != PartyOrgans.ZERO_PARTY_ORGAN
                    && self.numericalMatrix[x][y].organ != organ
            ) {
                revert InvalidOrgan(organ);
            }
            self.numericalMatrix[x][y].organ = organ;
            self.numericalMatrix[x][y].numericalSample
                .push(uint32(block.timestamp), uint224(bytes28(abi.encodePacked(author, value))));
        }
        emit ValueAdded(x, y, value, author);
    }

    function addCategory(
        PairOfMatricies storage self,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint64 category,
        string memory categoryName
    )
        internal
    {
        if (
            self.categoricalMatrix[x][y].organ != PartyOrgans.ZERO_PARTY_ORGAN
                && self.categoricalMatrix[x][y].organ != organ
        ) {
            revert InvalidOrgan(organ);
        }
        self.categoricalMatrix[x][y].organ = organ;
        if (!self.categoricalMatrix[x][y].allowedCategories.add(category)) {
            revert CategoryAlreadyExists(category);
        }
        self.categoricalMatrix[x][y].categoryNames[category] = categoryName;
        emit CategoryAdded(x, y, category);
    }

    function setDecimals(
        PairOfMatricies storage self,
        PartyOrgan organ,
        uint256 x,
        uint256 y,
        uint8 decimals
    )
        external
    {
        if (
            self.numericalMatrix[x][y].organ != PartyOrgans.ZERO_PARTY_ORGAN
                && self.numericalMatrix[x][y].organ != organ
        ) {
            revert InvalidOrgan(organ);
        }
        self.numericalMatrix[x][y].organ = organ;
        self.numericalMatrix[x][y].decimals = decimals;
    }

    function setTheme(PairOfMatricies storage self, bool isCategorical, uint256 x, string memory theme) external {
        self.themes[isCategorical][x] = theme;
    }

    function setStatement(
        PairOfMatricies storage self,
        bool isCategorical,
        uint256 x,
        uint256 y,
        string memory statement
    )
        external
    {
        if (bytes(self.themes[isCategorical][x]).length == 0) {
            revert NoThemeSet(isCategorical, x);
        }
        self.statements[isCategorical][y] = statement;
    }

    // ============ View Functions ============

    // Theme and Statement Queries
    function getTheme(
        PairOfMatricies storage self,
        bool isCategorical,
        uint256 x
    )
        internal
        view
        returns (string memory)
    {
        return self.themes[isCategorical][x];
    }

    function getStatement(
        PairOfMatricies storage self,
        bool isCategorical,
        uint256 y
    )
        internal
        view
        returns (string memory)
    {
        return self.statements[isCategorical][y];
    }

    // Organ Queries
    function getCategoricalCellOrgan(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (PartyOrgan)
    {
        return self.categoricalMatrix[x][y].organ;
    }

    function getNumericalCellOrgan(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (PartyOrgan)
    {
        return self.numericalMatrix[x][y].organ;
    }

    // Category Queries
    function getAllowedCategories(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (uint64[] memory)
    {
        uint256 length = self.categoricalMatrix[x][y].allowedCategories.length();
        uint64[] memory categories = new uint64[](length);
        for (uint256 i = 0; i < length; i++) {
            categories[i] = uint64(self.categoricalMatrix[x][y].allowedCategories.at(i));
        }
        return categories;
    }

    function getCategoryName(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint64 category
    )
        internal
        view
        returns (string memory)
    {
        return self.categoricalMatrix[x][y].categoryNames[category];
    }

    function isCategoryAllowed(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint64 category
    )
        internal
        view
        returns (bool)
    {
        return self.categoricalMatrix[x][y].allowedCategories.contains(category);
    }

    // Cell Info Aggregates
    function getCategoricalCellInfo(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (PartyOrgan organ, uint64[] memory allowedCategories, uint256 sampleLength)
    {
        organ = self.categoricalMatrix[x][y].organ;
        allowedCategories = getAllowedCategories(self, x, y);
        sampleLength = self.categoricalMatrix[x][y].categoricalSample.length();
    }

    function getNumericalCellInfo(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (PartyOrgan organ, uint8 decimals, uint256 sampleLength)
    {
        organ = self.numericalMatrix[x][y].organ;
        decimals = self.numericalMatrix[x][y].decimals;
        sampleLength = self.numericalMatrix[x][y].numericalSample.length();
    }

    // Sample Length Queries
    function getCategoricalSampleLength(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (uint256)
    {
        return self.categoricalMatrix[x][y].categoricalSample.length();
    }

    function getNumericalSampleLength(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (uint256)
    {
        return self.numericalMatrix[x][y].numericalSample.length();
    }

    // Latest Value Queries
    function getLatestCategoricalValue(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (DecodedCheckpoint memory)
    {
        (bool exists, uint32 timestamp, uint224 encodedValue) =
            self.categoricalMatrix[x][y].categoricalSample.latestCheckpoint();
        if (!exists) {
            return DecodedCheckpoint({timestamp: 0, author: address(0), value: 0});
        }
        return _decodeCheckpoint(timestamp, encodedValue);
    }

    function getLatestNumericalValue(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y
    )
        internal
        view
        returns (DecodedCheckpoint memory)
    {
        (bool exists, uint32 timestamp, uint224 encodedValue) =
            self.numericalMatrix[x][y].numericalSample.latestCheckpoint();
        if (!exists) {
            return DecodedCheckpoint({timestamp: 0, author: address(0), value: 0});
        }
        return _decodeCheckpoint(timestamp, encodedValue);
    }

    // Indexed Value Access
    function getCategoricalValueAt(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint32 index
    )
        internal
        view
        returns (DecodedCheckpoint memory)
    {
        Checkpoints.Checkpoint224 memory checkpoint = self.categoricalMatrix[x][y].categoricalSample.at(index);
        return _decodeCheckpoint(checkpoint._key, checkpoint._value);
    }

    function getNumericalValueAt(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint32 index
    )
        internal
        view
        returns (DecodedCheckpoint memory)
    {
        Checkpoints.Checkpoint224 memory checkpoint = self.numericalMatrix[x][y].numericalSample.at(index);
        return _decodeCheckpoint(checkpoint._key, checkpoint._value);
    }

    // Timestamp Lookup
    function getCategoricalValueAtTimestamp(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint32 timestamp
    )
        internal
        view
        returns (DecodedCheckpoint memory)
    {
        uint224 encodedValue = self.categoricalMatrix[x][y].categoricalSample.upperLookup(timestamp);
        if (encodedValue == 0) {
            return DecodedCheckpoint({timestamp: 0, author: address(0), value: 0});
        }
        return _decodeCheckpoint(timestamp, encodedValue);
    }

    function getNumericalValueAtTimestamp(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint32 timestamp
    )
        internal
        view
        returns (DecodedCheckpoint memory)
    {
        uint224 encodedValue = self.numericalMatrix[x][y].numericalSample.upperLookup(timestamp);
        if (encodedValue == 0) {
            return DecodedCheckpoint({timestamp: 0, author: address(0), value: 0});
        }
        return _decodeCheckpoint(timestamp, encodedValue);
    }

    // Paginated History Queries
    function getCategoricalHistory(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint32 offset,
        uint256 limit
    )
        internal
        view
        returns (uint32[] memory timestamps, address[] memory authors, uint64[] memory values)
    {
        uint256 totalLength = self.categoricalMatrix[x][y].categoricalSample.length();
        if (offset >= totalLength) {
            return (new uint32[](0), new address[](0), new uint64[](0));
        }

        uint256 remaining = totalLength - offset;
        uint256 resultLength = remaining < limit ? remaining : limit;

        timestamps = new uint32[](resultLength);
        authors = new address[](resultLength);
        values = new uint64[](resultLength);

        for (uint32 i = 0; i < resultLength; i++) {
            Checkpoints.Checkpoint224 memory checkpoint = self.categoricalMatrix[x][y].categoricalSample.at(offset + i);
            DecodedCheckpoint memory decoded = _decodeCheckpoint(checkpoint._key, checkpoint._value);
            timestamps[i] = decoded.timestamp;
            authors[i] = decoded.author;
            values[i] = decoded.value;
        }
    }

    function getNumericalHistory(
        PairOfMatricies storage self,
        uint256 x,
        uint256 y,
        uint32 offset,
        uint256 limit
    )
        internal
        view
        returns (uint32[] memory timestamps, address[] memory authors, uint64[] memory values)
    {
        uint256 totalLength = self.numericalMatrix[x][y].numericalSample.length();
        if (offset >= totalLength) {
            return (new uint32[](0), new address[](0), new uint64[](0));
        }

        uint256 remaining = totalLength - offset;
        uint256 resultLength = remaining < limit ? remaining : limit;

        timestamps = new uint32[](resultLength);
        authors = new address[](resultLength);
        values = new uint64[](resultLength);

        for (uint32 i = 0; i < resultLength; i++) {
            Checkpoints.Checkpoint224 memory checkpoint = self.numericalMatrix[x][y].numericalSample.at(offset + i);
            DecodedCheckpoint memory decoded = _decodeCheckpoint(checkpoint._key, checkpoint._value);
            timestamps[i] = decoded.timestamp;
            authors[i] = decoded.author;
            values[i] = decoded.value;
        }
    }
}
