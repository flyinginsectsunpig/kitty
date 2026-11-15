using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Expenses;
using static Kitty.Ledger.UnitTests.SplitCalculatorTests;

namespace Kitty.Ledger.UnitTests;

public class ExpenseValidatorTests
{
    private static readonly IReadOnlySet<Guid> Members = new HashSet<Guid> { A, B, C };

    private static ExpenseWriteDto Valid(long amount = 900) => new(
        Guid.NewGuid(), "Dinner", "food", "ZAR", amount, new DateOnly(2026, 11, 15),
        [new PayerDto(A, amount)],
        new SplitDto(SplitMethod.Equal, [new ParticipantDto(A, null), new ParticipantDto(B, null), new ParticipantDto(C, null)]),
        null);

    private static string? Code(ExpenseValidation v) => (v as ExpenseValidation.Invalid)?.Code;

    [Fact]
    public void Valid_equal_split_returns_shares()
    {
        var v = Assert.IsType<ExpenseValidation.Valid>(ExpenseValidator.Validate(Valid(), Members));
        Assert.Equal([new Share(A, 300), new Share(B, 300), new Share(C, 300)], v.Shares);
    }

    [Fact]
    public void Payers_must_sum_to_amount() =>
        Assert.Equal("payers_sum_mismatch", Code(ExpenseValidator.Validate(Valid() with { Payers = [new PayerDto(A, 100)] }, Members)));

    [Fact]
    public void Duplicate_payer_is_invalid() =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(
            Valid() with { Payers = [new PayerDto(A, 450), new PayerDto(A, 450)] }, Members)));

    [Fact]
    public void Payer_from_another_group_is_rejected() =>
        Assert.Equal("member_not_in_group", Code(ExpenseValidator.Validate(
            Valid() with { Payers = [new PayerDto(Guid.NewGuid(), 900)] }, Members)));

    [Fact]
    public void Participant_from_another_group_is_rejected() =>
        Assert.Equal("member_not_in_group", Code(ExpenseValidator.Validate(
            Valid() with { Split = new SplitDto(SplitMethod.Equal, [new ParticipantDto(Guid.NewGuid(), null)]) }, Members)));

    [Fact]
    public void Unknown_category_is_invalid() =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(Valid() with { Category = "yachts" }, Members)));

    [Fact]
    public void Unsupported_currency_is_rejected() =>
        Assert.Equal("currency_unsupported", Code(ExpenseValidator.Validate(Valid() with { Currency = "XXX" }, Members)));

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(10_000_000_001)]
    public void Amount_out_of_range_is_invalid(long amount) =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(
            Valid() with { AmountMinor = amount, Payers = [new PayerDto(A, amount)] }, Members)));

    [Fact]
    public void Payer_amounts_that_would_overflow_are_invalid_not_a_crash() =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(
            Valid() with { Payers = [new PayerDto(A, long.MaxValue), new PayerDto(B, long.MaxValue)] }, Members)));

    [Fact]
    public void Undefined_split_method_is_invalid_not_a_crash() =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(
            Valid() with { Split = new SplitDto((SplitMethod)99, [new ParticipantDto(A, null)]) }, Members)));

    [Fact]
    public void Itemized_expenses_cannot_be_written_directly() =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(
            Valid() with { Split = new SplitDto(SplitMethod.Itemized, [new ParticipantDto(A, null)]) }, Members)));

    [Fact]
    public void Blank_description_is_invalid() =>
        Assert.Equal("validation_failed", Code(ExpenseValidator.Validate(Valid() with { Description = "   " }, Members)));

    [Fact]
    public void Split_errors_pass_through() =>
        Assert.Equal("split_sum_mismatch", Code(ExpenseValidator.Validate(
            Valid() with { Split = new SplitDto(SplitMethod.Exact, [new ParticipantDto(A, 100)]) }, Members)));
}
