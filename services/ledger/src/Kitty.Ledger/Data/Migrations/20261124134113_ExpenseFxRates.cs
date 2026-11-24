using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class ExpenseFxRates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "ConvertedAmountMinor",
                table: "Expenses",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "FxRate",
                table: "Expenses",
                type: "numeric(20,10)",
                precision: 20,
                scale: 10,
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "FxRateDate",
                table: "Expenses",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FxRateSource",
                table: "Expenses",
                type: "character varying(6)",
                maxLength: 6,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ConvertedAmountMinor",
                table: "Expenses");

            migrationBuilder.DropColumn(
                name: "FxRate",
                table: "Expenses");

            migrationBuilder.DropColumn(
                name: "FxRateDate",
                table: "Expenses");

            migrationBuilder.DropColumn(
                name: "FxRateSource",
                table: "Expenses");
        }
    }
}
