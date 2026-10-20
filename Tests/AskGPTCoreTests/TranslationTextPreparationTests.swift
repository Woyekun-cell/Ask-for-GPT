import Testing
@testable import AskGPTCore

struct TranslationTextPreparationTests {
    @Test func ordinaryPDFWrapsKeepOneSentenceAndItsPunctuation() {
        let original = "The treatment increased the response\nacross both groups and reduced\nvariation."
        #expect(TranslationTextPreparation.preparePDFSelection(original)
            == "The treatment increased the response across both groups and reduced variation.")
    }

    @Test func paragraphBreaksAndHeadingsRemainDistinct() {
        let original = "Results\r\nThe treatment increased the response\r\nacross both groups.\r\n\r\nDiscussion\r\nThe observations support a cautious interpretation."
        #expect(TranslationTextPreparation.preparePDFSelection(original)
            == "Results\nThe treatment increased the response across both groups.\n\nDiscussion\nThe observations support a cautious interpretation.")
    }

    @Test func geneIDsNumbersUnitsAndNonbreakingHyphensAreNotRewritten() {
        let original = "The IL-6 and GZMB.1 signals increased\nin NC-I-12-S at 3.0 µm and 1.2e-3 mol/L."
        #expect(TranslationTextPreparation.preparePDFSelection(original)
            == "The IL-6 and GZMB.1 signals increased in NC-I-12-S at 3.0 µm and 1.2e-3 mol/L.")
        #expect(TranslationTextPreparation.preparePDFSelection("β-glucan\nIL-6\nGZMB.1\nNC-I-12-S")
            == "β-glucan\nIL-6\nGZMB.1\nNC-I-12-S")
    }

    @Test func formulasTablesAndListsRetainTheirLineStructure() {
        let original = "x = a + b\ny = 2.0 × x\n\nGene\tValue\nIL-6\t1.2e-3\n\n- first experimental group\n- second experimental group\n1. Keep this numbered item.\n2. Keep this numbered item too."
        #expect(TranslationTextPreparation.preparePDFSelection(original) == original)
    }

    @Test func explicitDiscretionaryHyphenIsRemovedOnlyBetweenLetters() {
        #expect(TranslationTextPreparation.preparePDFSelection("The transcrip\u{00AD}\ntional response increased.")
            == "The transcriptional response increased.")
        #expect(TranslationTextPreparation.preparePDFSelection("transcrip\u{00AD}tional") == "transcriptional")
    }

    @Test func knownLineBrokenWordsAreRejoinedWithoutChangingLetterCase() {
        #expect(TranslationTextPreparation.preparePDFSelection("inter-\nleukin") == "interleukin")
        #expect(TranslationTextPreparation.preparePDFSelection("TRANSCRIP-\nTIONAL") == "TRANSCRIPTIONAL")
        #expect(TranslationTextPreparation.preparePDFSelection("expres-\nsion") == "expression")
        #expect(TranslationTextPreparation.preparePDFSelection("metabo-\nlomics") == "metabolomics")
        #expect(TranslationTextPreparation.preparePDFSelection("transcrip-\ntomics") == "transcriptomics")
        #expect(TranslationTextPreparation.preparePDFSelection("bio-\nlogical") == "biological")
        #expect(TranslationTextPreparation.preparePDFSelection("tech-\nnical") == "technical")
    }

    @Test func unknownCompoundsAndGeneIDsKeepTheirHyphenWithoutAnInsertedSpace() {
        #expect(TranslationTextPreparation.preparePDFSelection("pan-\ngenome") == "pan-genome")
        #expect(TranslationTextPreparation.preparePDFSelection("HLA-\nDRA") == "HLA-DRA")
        #expect(TranslationTextPreparation.preparePDFSelection("IL-\n1β") == "IL-1β")
        #expect(TranslationTextPreparation.preparePDFSelection("IL-\n6") == "IL-6")
        #expect(TranslationTextPreparation.preparePDFSelection("notaword-\nfragment") == "notaword-fragment")
        #expect(TranslationTextPreparation.preparePDFSelection("pan-\n\ngenome") == "pan-\n\ngenome")
        #expect(TranslationTextPreparation.preparePDFSelection("x -\ny") == "x -\ny")
    }

    @Test func softHyphenDoesNotBridgeParagraphsOrRewriteNumericTokens() {
        let original = "transcrip\u{00AD}\n\ntional\nIL\u{00AD}\n6"
        #expect(TranslationTextPreparation.preparePDFSelection(original) == original)
    }

    @Test func unchangedPlainTextAndRepeatedPreparationAreStable() {
        let original = "β-glucan increased by 1.25-fold (P < 0.05)."
        #expect(TranslationTextPreparation.preparePDFSelection(original) == original)
        let wrapped = "The treatment increased the response\nacross both experimental groups."
        let prepared = TranslationTextPreparation.preparePDFSelection(wrapped)
        #expect(TranslationTextPreparation.preparePDFSelection(prepared) == prepared)
        #expect(TranslationTextPreparation.preparePDFSelection("") == "")
    }
}
